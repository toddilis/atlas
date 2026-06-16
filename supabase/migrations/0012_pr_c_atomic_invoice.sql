-- 0012_pr_c_atomic_invoice — transactional outbox + ledger posting RPCs for PR-C.
--
-- Three Postgres functions deliver the atomic side-effects PR-C needs:
--
-- 1. issue_invoice_atomic — runs inside one transaction so that the draft→issued state
--    transition, the Stripe-outbox enqueue, and the ledger posting either all land or none
--    do. PR-B's TS handler did only the state transition; PR-C replaces it with a thin
--    caller of this RPC.
--
-- 2. post_payment_received — when a Stripe webhook tells us an invoice was paid, the
--    webhook handler inserts a payments row and then calls this function to (a) post the
--    AR clearance ledger transaction and (b) transition the invoice to 'paid' (or
--    'partial' if the payment doesn't cover the total).
--
-- 3. unique index on payments(org_id, stripe_payment_id) — so webhook re-deliveries from
--    Stripe are deduped at the DB layer without us having to write select-then-insert.
--
-- The ledger postings hard-code the wholesale chart of accounts seeded by
-- seed_chart_of_accounts (0009): AR=1100, Revenue=4000, Tax Payable=2200, Stripe
-- Clearing=1110. The strategy is keyed by invoice.channel — only 'wholesale' is wired in
-- this PR; DTC/consignment fall through with a NOTICE so we'd notice immediately if a
-- non-wholesale invoice issuance slipped through.

-- ---------- payments idempotency ----------
create unique index payments_stripe_payment_id_unique
  on payments(org_id, stripe_payment_id)
  where stripe_payment_id is not null;

-- ---------- accounts.stripe_customer_id ----------
-- Populated during Stripe onboarding for each wholesale account. stripe.create_invoice
-- resolves account_id → stripe_customer_id via this column and refuses to auto-create
-- (onboarding is a deliberate operator step, not a tool side-effect).
alter table accounts add column stripe_customer_id text;
create unique index accounts_stripe_customer_id_unique
  on accounts(org_id, stripe_customer_id)
  where stripe_customer_id is not null;

-- ---------- issue_invoice_atomic ----------
-- Org id is passed explicitly: the rest of the Atlas code filters every query by
-- `org_id = orgId()` (the service role bypasses RLS), so the GUC `app.org_id` used by
-- the RLS policies is never set. Threading the org through the RPC parameter keeps the
-- function callable from the existing client without needing a session-level SET.
create or replace function issue_invoice_atomic(
  p_org_id               uuid,
  p_invoice_id           uuid,
  p_outbox_idempotency   text
) returns table (
  invoice_id          uuid,
  issued_at           timestamptz,
  outbox_id           uuid,
  ledger_transaction_id uuid
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_now           timestamptz := now();
  v_invoice       invoices%rowtype;
  v_revenue_cents bigint;
  v_outbox_id     uuid;
  v_txn_id        uuid;
  v_ar_id         uuid;
  v_revenue_id    uuid;
  v_tax_id        uuid;
begin
  if p_org_id is null then
    raise exception 'issue_invoice_atomic: p_org_id required';
  end if;

  -- Lock the invoice row and verify it's still a draft. The state='draft' check inside
  -- the UPDATE makes this safe against concurrent callers: only one wins.
  update invoices
     set state      = 'issued',
         issued_at  = v_now,
         updated_at = v_now
   where id       = p_invoice_id
     and org_id   = p_org_id
     and state    = 'draft'
  returning * into v_invoice;

  if v_invoice.id is null then
    raise exception
      'issue_invoice_atomic: no draft row to issue (invoice % missing or not in draft)',
      p_invoice_id;
  end if;

  -- Enqueue the Stripe-create-invoice side-effect. The drainer (outbox.drain in TS) will
  -- pick this up and call stripe.create_invoice which writes stripe_invoice_id back.
  insert into outbox (
    org_id, tool_name, action, payload, idempotency_key,
    related_subject_type, related_subject_id
  ) values (
    p_org_id,
    'stripe.create_invoice',
    'stripe.create_invoice',
    jsonb_build_object(
      'invoice_id',  v_invoice.id::text,
      'account_id',  v_invoice.account_id::text,
      'total_cents', v_invoice.total_cents,
      'currency',    v_invoice.currency
    ),
    p_outbox_idempotency,
    'invoice',
    v_invoice.id
  )
  returning id into v_outbox_id;

  -- Ledger posting strategy — only wholesale is wired in this PR.
  if v_invoice.channel = 'wholesale' then
    -- Resolve account ids for the wholesale chart. The seed function (0009) populates
    -- these on org bootstrap, so they MUST exist by now.
    select id into v_ar_id      from ledger_accounts
      where org_id = p_org_id and code = '1100' and active;
    select id into v_revenue_id from ledger_accounts
      where org_id = p_org_id and code = '4000' and active;
    select id into v_tax_id     from ledger_accounts
      where org_id = p_org_id and code = '2200' and active;
    if v_ar_id is null or v_revenue_id is null or v_tax_id is null then
      raise exception
        'issue_invoice_atomic: missing wholesale chart of accounts for org % (1100/4000/2200)',
        p_org_id;
    end if;

    v_revenue_cents := v_invoice.total_cents - coalesce(v_invoice.tax_cents, 0);

    insert into ledger_transactions (
      org_id, channel, source, source_ref, source_ref_type,
      description, occurred_at, posted_at, posted_by_agent
    ) values (
      p_org_id, v_invoice.channel, 'invoice_issued', v_invoice.id, 'invoice',
      format('Invoice %s issued', v_invoice.invoice_number),
      v_now, v_now, 'controller'
    )
    returning id into v_txn_id;

    -- Lines: +AR, -Revenue, -Tax. Signed cents; the deferred trigger validates sum=0.
    insert into ledger_lines (org_id, transaction_id, ledger_account_id, amount_cents, currency, memo)
    values
      (p_org_id, v_txn_id, v_ar_id,      v_invoice.total_cents,         v_invoice.currency, 'AR receivable'),
      (p_org_id, v_txn_id, v_revenue_id, -v_revenue_cents,              v_invoice.currency, 'Revenue (net of tax)');

    if coalesce(v_invoice.tax_cents, 0) > 0 then
      insert into ledger_lines (org_id, transaction_id, ledger_account_id, amount_cents, currency, memo)
      values (p_org_id, v_txn_id, v_tax_id, -v_invoice.tax_cents, v_invoice.currency, 'Sales tax payable');
    end if;
  else
    raise notice
      'issue_invoice_atomic: channel % has no ledger strategy yet (PR-C wires wholesale only)',
      v_invoice.channel;
    v_txn_id := null;
  end if;

  return query select v_invoice.id, v_invoice.issued_at, v_outbox_id, v_txn_id;
end $$;

-- ---------- post_payment_received ----------
-- The Stripe-webhook handler inserts the payments row first (idempotent on stripe_payment_id)
-- and then calls this function to post the ledger and transition the invoice. Idempotency
-- across re-runs is enforced via the payments unique index above and a guard on the invoice
-- state.
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

  select * into v_payment from payments
    where id = p_payment_id and org_id = p_org_id;
  if v_payment.id is null then
    raise exception 'post_payment_received: payment % not found', p_payment_id;
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

  return query select v_payment.id, v_txn_id, v_new_state;
end $$;
