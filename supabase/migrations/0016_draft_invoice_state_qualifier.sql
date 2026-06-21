-- 0016_draft_invoice_state_qualifier — fix-forward for an ambiguous column
-- reference in draft_invoice_atomic.
--
-- 0013 introduced draft_invoice_atomic with a local variable `v_state`, and 0014
-- replaced the function body for GST while keeping the same shape. Both versions
-- contain an idempotency check that references the bare column name `state` in a
-- WHERE clause:
--
--     select * into v_existing from invoices
--      where org_id = p_org_id
--        and fulfillment_event_id = p_fulfillment_event_id
--        and state <> 'void';
--
-- Postgres' plpgsql variable_conflict default ('error' in stricter installs,
-- 'use_variable' historically) flags this as ambiguous because the function declares
-- `v_state invoice_state` — and on live Atlas it raises 42702 at call time. The unit
-- tests in PR-D/PR-E mocked the supabase client so the RPC was never actually
-- invoked in CI; the migrate-apply check was deferred. The first live invocation
-- (during PR-H verification, post-merge) surfaced it.
--
-- Fix: qualify the column reference (`invoices.state`). Functionally identical;
-- just disambiguates against the local variable for the parser.

create or replace function draft_invoice_atomic(
  p_org_id                uuid,
  p_account_id            uuid,
  p_fulfillment_event_id  uuid,
  p_currency              char(3),
  p_lines                 jsonb
) returns table (
  invoice_id     uuid,
  invoice_number text,
  state          invoice_state,
  total_cents    bigint,
  was_existing   boolean
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_now             timestamptz := now();
  v_invoice_id      uuid;
  v_invoice_number  text;
  v_state           invoice_state;
  v_total_cents     bigint;
  v_subtotal_cents  bigint;
  v_tax_cents       bigint;
  v_rate_bps        integer;
  v_tax_exempt      boolean;
  v_line            jsonb;
  v_existing        invoices%rowtype;
begin
  if p_org_id is null or p_account_id is null or p_fulfillment_event_id is null then
    raise exception 'draft_invoice_atomic: org/account/fulfillment_event required';
  end if;

  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines) = 0 then
    raise exception 'draft_invoice_atomic: p_lines must be a non-empty array';
  end if;

  -- Idempotency: if a non-void draft already exists for this fulfillment, return it.
  -- Column reference is qualified to disambiguate against the v_state local variable
  -- (the actual fix from 0014's version).
  select * into v_existing from invoices
   where org_id = p_org_id
     and fulfillment_event_id = p_fulfillment_event_id
     and invoices.state <> 'void'
   limit 1;
  if v_existing.id is not null then
    return query select v_existing.id,
                         v_existing.invoice_number,
                         v_existing.state,
                         v_existing.total_cents,
                         true;
    return;
  end if;

  select gst_rate_bps into v_rate_bps from orgs where id = p_org_id;
  if v_rate_bps is null then
    raise exception 'draft_invoice_atomic: org % not found', p_org_id;
  end if;
  select tax_exempt into v_tax_exempt from accounts
    where id = p_account_id and org_id = p_org_id;
  if v_tax_exempt is null then
    raise exception 'draft_invoice_atomic: account % not found in org %',
      p_account_id, p_org_id;
  end if;

  v_subtotal_cents := 0;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_subtotal_cents := v_subtotal_cents
      + ((v_line->>'quantity')::numeric * (v_line->>'unit_price_cents')::bigint)::bigint;
  end loop;

  if v_tax_exempt then
    v_tax_cents := 0;
  else
    v_tax_cents := compute_gst_cents(v_subtotal_cents, v_rate_bps);
  end if;
  v_total_cents := v_subtotal_cents + v_tax_cents;

  v_invoice_number := next_invoice_number(p_org_id);

  insert into invoices (
    org_id, channel, account_id, invoice_number, state, currency,
    subtotal_cents, tax_cents, total_cents, fulfillment_event_id, created_at, updated_at
  ) values (
    p_org_id, 'wholesale', p_account_id, v_invoice_number, 'draft', p_currency,
    v_subtotal_cents, v_tax_cents, v_total_cents, p_fulfillment_event_id, v_now, v_now
  )
  returning id, invoices.state into v_invoice_id, v_state;

  insert into invoice_lines (org_id, invoice_id, product_id, description, quantity, unit_price_cents, total_cents)
  select p_org_id,
         v_invoice_id,
         nullif(line->>'product_id','')::uuid,
         line->>'description',
         (line->>'quantity')::numeric,
         (line->>'unit_price_cents')::bigint,
         ((line->>'quantity')::numeric * (line->>'unit_price_cents')::bigint)::bigint
    from jsonb_array_elements(p_lines) line;

  return query select v_invoice_id, v_invoice_number, v_state, v_total_cents, false;
end $$;
