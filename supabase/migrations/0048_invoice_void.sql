-- CLOSE-01c: a wrongly issued invoice is no longer permanent. 'void' has been in the
-- invoice state enum since 0003 and every reader honors it (statements exclude it,
-- payments refuse it, the console filters it), but nothing could ever write it — a
-- mistaken issue stayed a live receivable forever. operator_void_invoice voids an
-- issued invoice with a required reason and posts the EXACT reversing ledger entry
-- (the negation of the stored issue posting, never a recomputation), so receivables
-- and future statements tell the truth while every historical row stays immutable.
--
-- Boundaries, stated rather than papered over:
--   * Only an issued invoice voids ('overdue' is derived at read time, never stored).
--     A draft belongs to the approval machinery; an invoice with recorded payments
--     needs the payment reallocated first (FLOW-01 reconciliation), so it is refused.
--   * The dispatch's billing claim (0021) is append-only and stays consumed: voiding
--     corrects the money record, it does not re-open the dispatch for the draft job.
--     Re-billing a voided part is its own correction flow.
--   * invoices.void is NEVER seeded at boot: reversing a posted receivable is a
--     deliberate business switch, like issuing and payment entry. An approve_required
--     grant is refused outright (no approval flow is built for it).
--
-- post_payment_received is also redefined (forward, from its 0018 body) with a void
-- guard: without it, a Stripe webhook payment could transition a voided invoice to
-- partial/paid and post AR clearance against a reversed receivable. The operator path
-- (0043) already refuses; now the webhook path does too, with the same message.

alter table invoices add column voided_at timestamptz;
alter table invoices add column voided_by text;
alter table invoices add column voided_reason text;
comment on column invoices.voided_reason is 'Why the invoice was voided (0048). The reversal is its own ledger transaction; nothing is deleted.';
alter table invoices add constraint invoices_void_evidence check (
  (state <> 'void' or (voided_at is not null and voided_reason is not null))
  and (state = 'void' or (voided_at is null and voided_by is null and voided_reason is null))
);

create function operator_void_invoice(p_org_id uuid,p_invoice_id uuid,p_reason text,p_actor_id uuid,p_actor_email text)
returns table(ovi_state invoice_state,ovi_voided_at timestamptz,ovi_reversal_transaction_id uuid)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_inv invoices%rowtype; v_reason text:=trim(coalesce(p_reason,'')); v_issue_txn ledger_transactions%rowtype;
        v_txn_id uuid; v_was invoice_state;
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  if length(v_reason)<3 then raise exception 'void reason required'; end if;
  if length(v_reason)>500 then raise exception 'void reason too long'; end if;
  perform assert_action_authority(p_org_id,'operator','invoices.void');
  if exists(select 1 from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='invoices.void'
    and risk='approve_required') then raise exception 'voiding an invoice cannot itself require an approval; its grant must not require approval'; end if;
  select * into v_inv from invoices where org_id=p_org_id and id=p_invoice_id for update;
  if not found then raise exception 'invoice not found'; end if;
  if v_inv.state='void' then
    if v_inv.voided_reason=v_reason then
      select t.id into v_txn_id from ledger_transactions t where t.org_id=p_org_id and t.source='invoice_voided'
        and t.source_ref=v_inv.id and t.source_ref_type='invoice' limit 1;
      return query select v_inv.state,v_inv.voided_at,v_txn_id; return;
    end if;
    raise exception 'invoice already voided';
  end if;
  if exists(select 1 from payments where org_id=p_org_id and invoice_id=v_inv.id)
    or v_inv.state in ('paid','partial') then
    raise exception 'an invoice with recorded payments cannot be voided; reallocate the payment first'; end if;
  if v_inv.state<>'issued' then raise exception 'only an issued invoice can be voided'; end if;
  v_was:=v_inv.state;

  update invoices set state='void',voided_at=clock_timestamp(),voided_by=trim(p_actor_email),voided_reason=v_reason,
    updated_at=clock_timestamp() where id=v_inv.id returning * into v_inv;

  -- Reverse the stored issue posting exactly: negate its own lines rather than
  -- recomputing from totals, so tax-free and edge postings reverse to zero by
  -- construction. A channel that never posted (non-wholesale) has nothing to reverse.
  select * into v_issue_txn from ledger_transactions where org_id=p_org_id and source='invoice_issued'
    and source_ref=v_inv.id and source_ref_type='invoice' limit 1;
  if found then
    insert into ledger_transactions(org_id,channel,source,source_ref,source_ref_type,description,occurred_at,posted_at,posted_by_agent)
      values(p_org_id,v_issue_txn.channel,'invoice_voided',v_inv.id,'invoice',
        format('Invoice %s voided: %s',v_inv.invoice_number,v_reason),clock_timestamp(),clock_timestamp(),'operator')
      returning id into v_txn_id;
    insert into ledger_lines(org_id,transaction_id,ledger_account_id,amount_cents,currency,memo)
      select p_org_id,v_txn_id,l.ledger_account_id,-l.amount_cents,l.currency,'Reversal: '||l.memo
        from ledger_lines l where l.org_id=p_org_id and l.transaction_id=v_issue_txn.id;
  end if;

  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','invoices.void','invoices.void','invoice',v_inv.id,'notify','success',
      jsonb_build_object('actor_id',p_actor_id,'actor_email',trim(p_actor_email),'invoice_number',v_inv.invoice_number,
        'was_state',v_was,'reason',v_reason,'reversal_transaction_id',v_txn_id,'total_cents',v_inv.total_cents::text));
  return query select v_inv.state,v_inv.voided_at,v_txn_id;
end $$;

-- The 0028 snapshot guard lets lifecycle fields change on a snapshot-bearing invoice
-- while accepted BILL content stays immutable. The void evidence columns are lifecycle,
-- not content — without this, voiding a REAL dispatch part (the only invoices VICE
-- issues) is refused with 'invoice snapshot content is immutable'; the browser journey
-- caught exactly that against a hand-inserted probe fixture that carried no snapshot.
-- Exactly the 0028 body with the three columns added to the invoices allowlist.
create or replace function protect_billing_snapshot() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if TG_TABLE_NAME='invoices' then
    if exists(select 1 from invoice_calculation_snapshots where invoice_id=old.id) and
      (TG_OP='DELETE' or (to_jsonb(new)-array['state','issued_at','paid_at','updated_at','stripe_invoice_id','voided_at','voided_by','voided_reason']) is distinct from
       (to_jsonb(old)-array['state','issued_at','paid_at','updated_at','stripe_invoice_id','voided_at','voided_by','voided_reason'])) then raise exception 'invoice snapshot content is immutable'; end if;
  elsif exists(select 1 from invoice_calculation_snapshots where invoice_id=case when TG_OP='INSERT' then new.invoice_id else old.invoice_id end)
    or (TG_OP='UPDATE' and exists(select 1 from invoice_calculation_snapshots where invoice_id=new.invoice_id)) then raise exception 'snapshot invoice lines are immutable'; end if;
  if TG_OP='DELETE' then return old; end if; return new;
end $$;

-- post_payment_received, exactly the 0018 body plus the void guard after the invoice
-- lock. CREATE OR REPLACE keeps the function's existing privileges.
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

  -- A voided invoice's receivable was reversed (0048): a late webhook or retry must
  -- fail loudly for reconciliation, never resurrect the invoice or post against it.
  if v_invoice.state = 'void' then
    raise exception 'a void invoice cannot receive a payment';
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

do $$ declare r text; f regprocedure; begin
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('operator_void_invoice') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
