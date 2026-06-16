-- 0013_pr_d_pricing_drafts — pricing resolver + draft_invoice transactional path.
--
-- Two pieces:
--
-- 1. invoice_counters — per-org monotonic counter for invoice numbers. Atomic on the
--    counter row's update gives us race-free `ATL-0001`-style numbering. One row per
--    org is created on demand inside the RPC.
--
-- 2. draft_invoice_atomic — inserts the invoices row + invoice_lines in one transaction.
--    The TS draft_invoice tool resolves prices and builds the line array; this function
--    just persists it, assigns the next invoice number, and computes the totals from the
--    line array (defending against caller arithmetic drift). Idempotency: the
--    fulfillment_event_id has a unique partial index so a re-run on the same fulfillment
--    returns the existing draft row instead of creating a duplicate.

-- ---------- invoice_counters ----------
create table invoice_counters (
  org_id      uuid primary key references orgs(id) on delete cascade,
  next_seq    integer not null default 1,
  updated_at  timestamptz not null default now()
);

alter table invoice_counters enable row level security;
-- Service-role bypasses RLS; no authenticated policies needed for an internal counter table.

-- ---------- invoice idempotency on fulfillment_event_id ----------
-- A wholesale invoice is the deterministic projection of a single fulfillment_event.
-- The unique partial index makes draft_invoice_atomic idempotent — a re-run hits the
-- conflict and returns the existing row rather than creating a duplicate. Voided
-- invoices are excluded so a re-draft is possible after a void.
create unique index invoices_fulfillment_event_unique
  on invoices(org_id, fulfillment_event_id)
  where fulfillment_event_id is not null and state <> 'void';

-- ---------- next_invoice_number ----------
-- Atomic counter increment. The insert-on-conflict-update creates the row on first
-- call and bumps it on every subsequent call. The `returning` clause is the new value.
create or replace function next_invoice_number(p_org_id uuid)
returns text
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_seq integer;
begin
  if p_org_id is null then
    raise exception 'next_invoice_number: p_org_id required';
  end if;

  insert into invoice_counters (org_id, next_seq, updated_at)
       values (p_org_id, 2, now())
  on conflict (org_id) do update
       set next_seq   = invoice_counters.next_seq + 1,
           updated_at = now()
  returning invoice_counters.next_seq - 1 into v_seq;

  return format('ATL-%s', lpad(v_seq::text, 4, '0'));
end $$;

-- ---------- draft_invoice_atomic ----------
-- Lines are passed as a jsonb array of objects:
--   [{ product_id, description, quantity, unit_price_cents }, ...]
-- The function sums them into subtotal/total (tax_cents=0 in this PR — wholesale GST
-- wires in a later PR alongside per-account tax configuration) and writes both rows
-- in one transaction. Returns the new invoice id + number (or the existing row's
-- values if the fulfillment already has a non-void draft).
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
  select * into v_existing from invoices
   where org_id = p_org_id
     and fulfillment_event_id = p_fulfillment_event_id
     and state <> 'void'
   limit 1;
  if v_existing.id is not null then
    return query select v_existing.id,
                         v_existing.invoice_number,
                         v_existing.state,
                         v_existing.total_cents,
                         true;
    return;
  end if;

  -- Sum subtotal from the line array. tax_cents = 0 in this PR.
  v_subtotal_cents := 0;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_subtotal_cents := v_subtotal_cents
      + ((v_line->>'quantity')::numeric * (v_line->>'unit_price_cents')::bigint)::bigint;
  end loop;
  v_total_cents := v_subtotal_cents;

  v_invoice_number := next_invoice_number(p_org_id);

  insert into invoices (
    org_id, channel, account_id, invoice_number, state, currency,
    subtotal_cents, tax_cents, total_cents, fulfillment_event_id, created_at, updated_at
  ) values (
    p_org_id, 'wholesale', p_account_id, v_invoice_number, 'draft', p_currency,
    v_subtotal_cents, 0, v_total_cents, p_fulfillment_event_id, v_now, v_now
  )
  returning id, state into v_invoice_id, v_state;

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
