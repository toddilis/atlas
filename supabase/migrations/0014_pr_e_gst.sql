-- 0014_pr_e_gst — wholesale GST handling.
--
-- Wires NZ GST into the draft path. Tax was hard-coded to 0 in 0013; this PR replaces
-- draft_invoice_atomic so it computes tax_cents from the org's configured rate, gated
-- by per-account exemption (for export accounts and similar).
--
-- Rounding: floor (integer division). Defensive against minor cross-language drift
-- between SQL and any future TS-side preview helper. NZ IRD accepts consistent rounding
-- methods; floor is conservative (under-charges by up to 1 cent per invoice rather than
-- over-charging).
--
-- Schema additions:
--   orgs.gst_rate_bps        — basis points (1500 = 15%). Default matches NZ GST.
--   accounts.tax_exempt      — when true (export / zero-rated supplies), tax = 0
--                              regardless of the org rate.
--
-- The existing 0012 wholesale ledger strategy already credits the 2200 Tax Payable
-- account when invoice.tax_cents > 0, so once drafts carry tax, the ledger posting on
-- issuance will split correctly without further migration changes.

-- ---------- schema ----------
alter table orgs     add column gst_rate_bps integer not null default 1500
  check (gst_rate_bps >= 0 and gst_rate_bps <= 10000);
alter table accounts add column tax_exempt   boolean not null default false;

comment on column orgs.gst_rate_bps is
  'Org-wide tax rate in basis points. 1500 = 15% (NZ GST). 0 disables tax.';
comment on column accounts.tax_exempt is
  'When true, invoices to this account are zero-rated (export, gov entity, etc.).';

-- ---------- compute_gst_cents helper ----------
-- Pure function so the TS-side preview helper has a Postgres referent to compare against
-- in live verification. Floor semantics; both inputs non-negative (the caller asserts).
create or replace function compute_gst_cents(p_subtotal_cents bigint, p_rate_bps integer)
returns bigint
language plpgsql
immutable
security invoker
set search_path = pg_catalog, public
as $$
begin
  if p_subtotal_cents is null or p_rate_bps is null then
    return 0;
  end if;
  if p_subtotal_cents < 0 or p_rate_bps < 0 then
    raise exception 'compute_gst_cents: inputs must be non-negative';
  end if;
  -- Integer division → floor for positive numerators.
  return (p_subtotal_cents * p_rate_bps) / 10000;
end $$;

-- ---------- draft_invoice_atomic (replaces 0013 version) ----------
-- Same signature + idempotency behaviour as before, but now reads gst_rate_bps from
-- orgs and tax_exempt from accounts to compute tax_cents.
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

  -- Tax inputs.
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

  -- Subtotal from the line array.
  v_subtotal_cents := 0;
  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_subtotal_cents := v_subtotal_cents
      + ((v_line->>'quantity')::numeric * (v_line->>'unit_price_cents')::bigint)::bigint;
  end loop;

  -- Tax. Exempt accounts always get 0.
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
