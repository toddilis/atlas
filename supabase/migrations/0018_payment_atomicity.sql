-- 0018_payment_atomicity — Phase 2.5 PR-K.
--
-- Review finding (HIGH): the Stripe webhook inserted the payments row and then called
-- post_payment_received as a SEPARATE round-trip. A crash between the two stranded the
-- payment: on redelivery the insert hit the unique index, the handler returned early, and
-- the ledger posting + invoice transition were never applied. PR-J made that state visible
-- (the projection stays 'failed'); this migration makes it impossible going forward and
-- self-healing for anything already stranded.
--
-- Two changes:
--
-- 1. payments.posted_at — the internal already-posted guard post_payment_received never
--    had. Null means the ledger posting / invoice transition for this payment has not been
--    applied. post_payment_received is replaced in place (same signature): it now locks the
--    payment row, no-ops when posted_at is set (returning the existing posting), and stamps
--    posted_at in the same transaction as the posting. Double invocation can no longer
--    double-credit AR.
--
-- 2. record_stripe_payment — what the webhook projector calls now. Resolves the canonical
--    invoice, inserts-or-adopts the payment row, and posts — all in ONE transaction. There
--    is no longer any crash window between "payment recorded" and "books updated", and a
--    redelivery that finds a stranded (unposted) payment row completes the posting instead
--    of skipping it.

-- ---------- posted_at guard column ----------

alter table payments add column posted_at timestamptz;

comment on column payments.posted_at is
  'When the ledger posting + invoice transition for this payment were applied '
  '(post_payment_received). Null = not yet applied; record_stripe_payment heals these.';

-- Backfill only where there is evidence the posting actually happened: a payment_received
-- ledger transaction referencing the payment, or (for channels with no ledger strategy yet,
-- which post nothing by design) an invoice that did transition. A genuinely stranded
-- pre-0018 payment matches neither, stays null, and is completed by the next
-- record_stripe_payment call for the same stripe_payment_id — or manually via
-- select * from post_payment_received(org_id, payment_id).
update payments p
   set posted_at = p.received_at
 where p.posted_at is null
   and (
     exists (select 1 from ledger_transactions t
              where t.org_id = p.org_id
                and t.source = 'payment_received'
                and t.source_ref = p.id)
     or exists (select 1 from invoices i
                 where i.id = p.invoice_id
                   and i.org_id = p.org_id
                   and i.state in ('paid', 'partial')
                   and i.channel <> 'wholesale')
   );

-- ---------- post_payment_received: replaced in place, now idempotent ----------
-- Same signature and return shape as 0012; callers are unaffected. Body changes:
-- payment row is locked (serialises concurrent invocations), posted_at short-circuits
-- re-runs, and posted_at is stamped with the posting in the same transaction.

create or replace function post_payment_received(
  p_org_id     uuid,
  p_payment_id uuid
) returns table (
  payment_id            uuid,
  ledger_transaction_id uuid,
  invoice_state         invoice_state
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_now          timestamptz := now();
  v_payment      payments%rowtype;
  v_invoice      invoices%rowtype;
  v_total_paid   bigint;
  v_new_state    invoice_state;
  v_txn_id       uuid;
  v_clearing_id  uuid;
  v_ar_id        uuid;
begin
  if p_org_id is null then
    raise exception 'post_payment_received: p_org_id required';
  end if;

  -- Lock the payment row: concurrent invocations for the same payment serialise here,
  -- so exactly one performs the posting and the rest take the posted_at short-circuit.
  select * into v_payment from payments
    where id = p_payment_id and org_id = p_org_id
    for update;
  if v_payment.id is null then
    raise exception 'post_payment_received: payment % not found', p_payment_id;
  end if;

  -- Already posted → idempotent no-op returning the existing posting.
  if v_payment.posted_at is not null then
    select t.id into v_txn_id from ledger_transactions t
      where t.org_id = p_org_id
        and t.source = 'payment_received'
        and t.source_ref = v_payment.id
      limit 1;
    select i.state into v_new_state from invoices i
      where i.id = v_payment.invoice_id and i.org_id = p_org_id;
    return query select v_payment.id, v_txn_id, v_new_state;
    return;
  end if;

  select * into v_invoice from invoices
    where id = v_payment.invoice_id and org_id = p_org_id
    for update;
  if v_invoice.id is null then
    raise exception 'post_payment_received: invoice % missing for payment %',
      v_payment.invoice_id, p_payment_id;
  end if;

  -- Sum of all payments against this invoice (including this one).
  select coalesce(sum(amount_cents), 0) into v_total_paid
    from payments
   where org_id = p_org_id and invoice_id = v_invoice.id;

  if v_total_paid >= v_invoice.total_cents then
    v_new_state := 'paid';
  else
    v_new_state := 'partial';
  end if;

  -- Don't downgrade a paid invoice to partial if a stale event arrives.
  if v_invoice.state = 'paid' and v_new_state = 'partial' then
    v_new_state := 'paid';
  end if;

  update invoices
     set state      = v_new_state,
         paid_at    = case when v_new_state = 'paid' then v_now else paid_at end,
         updated_at = v_now
   where id = v_invoice.id;

  -- Ledger posting — wholesale only (same caveat as issuance).
  if v_invoice.channel = 'wholesale' then
    select id into v_clearing_id from ledger_accounts
      where org_id = p_org_id and code = '1110' and active;
    select id into v_ar_id       from ledger_accounts
      where org_id = p_org_id and code = '1100' and active;
    if v_clearing_id is null or v_ar_id is null then
      raise exception
        'post_payment_received: missing wholesale chart (1110/1100) for org %', p_org_id;
    end if;

    insert into ledger_transactions (
      org_id, channel, source, source_ref, source_ref_type,
      description, occurred_at, posted_at, posted_by_agent
    ) values (
      p_org_id, v_invoice.channel, 'payment_received', v_payment.id, 'payment',
      format('Payment received for invoice %s', v_invoice.invoice_number),
      v_payment.received_at, v_now, 'controller'
    )
    returning id into v_txn_id;

    insert into ledger_lines (org_id, transaction_id, ledger_account_id, amount_cents, currency, memo)
    values
      (p_org_id, v_txn_id, v_clearing_id,  v_payment.amount_cents, v_payment.currency, 'Stripe clearing'),
      (p_org_id, v_txn_id, v_ar_id,       -v_payment.amount_cents, v_payment.currency, 'AR clearance');
  else
    raise notice
      'post_payment_received: channel % has no ledger strategy yet', v_invoice.channel;
    v_txn_id := null;
  end if;

  -- The guard is stamped in the same transaction as the posting: both land or neither.
  update payments set posted_at = v_now where id = v_payment.id;

  return query select v_payment.id, v_txn_id, v_new_state;
end $$;

-- ---------- record_stripe_payment ----------
-- Single-transaction ingestion for the Stripe webhook projector: resolve invoice →
-- insert-or-adopt payment → post (idempotent via posted_at). Output column names are
-- chosen to collide with no table column referenced in the body (the 0016 lesson:
-- RETURNS TABLE names are implicit variables and shadow bare column references).

create function record_stripe_payment(
  p_org_id            uuid,
  p_stripe_invoice_id text,
  p_stripe_payment_id text,
  p_amount_cents      bigint,
  p_currency          char(3),
  p_received_at       timestamptz,
  p_raw               jsonb
) returns table (
  rsp_payment_id    uuid,
  rsp_invoice_id    uuid,
  rsp_invoice_state invoice_state,
  rsp_was_existing  boolean
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_invoice     invoices%rowtype;
  v_payment_id  uuid;
  v_was_existing boolean := false;
  v_state       invoice_state;
begin
  if p_org_id is null or p_stripe_invoice_id is null or p_stripe_payment_id is null then
    raise exception 'record_stripe_payment: org, stripe_invoice_id and stripe_payment_id required';
  end if;
  if p_amount_cents is null or p_amount_cents <= 0 then
    raise exception 'record_stripe_payment: p_amount_cents must be positive, got %', p_amount_cents;
  end if;

  select * into v_invoice from invoices
    where org_id = p_org_id and stripe_invoice_id = p_stripe_invoice_id;
  if v_invoice.id is null then
    raise exception 'record_stripe_payment: no canonical invoice for stripe_invoice_id %',
      p_stripe_invoice_id;
  end if;

  -- Insert-or-adopt. A concurrent delivery of the same payment blocks on the speculative
  -- insert, then falls through to the adopt path; the posted_at lock in
  -- post_payment_received serialises the posting itself.
  insert into payments (org_id, invoice_id, amount_cents, currency, method,
                        stripe_payment_id, received_at, raw)
  values (
    p_org_id,
    v_invoice.id,
    p_amount_cents,
    coalesce(nullif(upper(p_currency), ''), v_invoice.currency),
    'stripe',
    p_stripe_payment_id,
    coalesce(p_received_at, now()),
    coalesce(p_raw, '{}'::jsonb)
  )
  on conflict (org_id, stripe_payment_id) where stripe_payment_id is not null do nothing
  returning id into v_payment_id;

  if v_payment_id is null then
    v_was_existing := true;
    select id into v_payment_id from payments
      where org_id = p_org_id and stripe_payment_id = p_stripe_payment_id;
    if v_payment_id is null then
      raise exception 'record_stripe_payment: payment % conflicted but is not readable',
        p_stripe_payment_id;
    end if;
  end if;

  -- Post in this same transaction. Idempotent: a previously-posted payment no-ops; a
  -- stranded pre-0018 payment (posted_at null) is completed here — the self-heal path.
  select t.invoice_state into v_state
    from post_payment_received(p_org_id, v_payment_id) t;

  return query select v_payment_id, v_invoice.id, v_state, v_was_existing;
end $$;
