-- PAY-01 (FLOW-01's manual leg): an operator records a bank payment against an issued
-- invoice in the console. VICE settles by bank transfer, and until now the only payment
-- writer was the Stripe path (0018) — an issued invoice could never become paid through
-- any operator surface. This entry point has the same single-transaction
-- insert-or-adopt-then-post shape as record_stripe_payment, with the operator rules on
-- top: identity, action pause, the payments.record grant (NEVER seeded at boot — like
-- manual carrier costs, a business turns manual entry of external financial facts on
-- deliberately; a grant set to approve_required is refused outright), a bank reference
-- as the per-invoice idempotency key, the amount capped at what is outstanding, the
-- invoice's own currency always (a different-currency transfer is FLOW-01's bank-leg
-- reconciliation, never a silent conversion here), and an audit row. The posting itself
-- stays owned by post_payment_received (0018): idempotent via posted_at, ledger and
-- invoice transition in the same transaction. Service-role only.

alter table payments add column reference text;
comment on column payments.reference is
  'Operator-entered bank reference (0043). One bank line may settle several invoices, '
  'so it is unique per invoice, not per business; an exact retry adopts the stored payment.';
create unique index payments_operator_reference on payments(org_id, invoice_id, reference) where reference is not null;

create function operator_record_payment(p_org_id uuid,p_invoice_id uuid,p_amount_cents bigint,p_received_at timestamptz,
  p_reference text,p_actor_id uuid,p_actor_email text)
returns table(orp_payment_id uuid,orp_invoice_state invoice_state,orp_was_existing boolean)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_invoice invoices%rowtype; v_stored payments%rowtype; v_reference text:=trim(coalesce(p_reference,''));
  v_paid bigint; v_payment_id uuid; v_was_existing boolean:=false; v_state invoice_state; v_risk text;
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','payments.record');
  select risk into v_risk from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='payments.record' and enabled;
  if v_risk='approve_required' then raise exception 'recording a payment cannot itself require an approval; its grant must not require approval'; end if;
  if length(v_reference)<3 or length(v_reference)>100 then raise exception 'payment reference required'; end if;
  if p_amount_cents is null or p_amount_cents<=0 then raise exception 'payment amount must be positive'; end if;
  -- A console date-only entry arrives as that date's UTC midnight; "today" in a UTC+13
  -- business is up to 14 hours ahead of UTC now, so the future check allows that skew
  -- while still refusing genuinely future-dated entries (tomorrow and beyond).
  if p_received_at is null or p_received_at>clock_timestamp()+interval '14 hours' then raise exception 'payment date must not be in the future'; end if;

  select * into v_invoice from invoices where org_id=p_org_id and id=p_invoice_id for update;
  if not found then raise exception 'invoice not found'; end if;
  if v_invoice.state='void' then raise exception 'a void invoice cannot receive a payment'; end if;
  if v_invoice.state='paid' then raise exception 'this invoice is already fully paid; an overpayment or refund is an explicit correction, not a payment entry'; end if;
  if v_invoice.state not in ('issued','partial') then raise exception 'only an issued invoice can receive a payment'; end if;

  select coalesce(sum(amount_cents),0) into v_paid from payments where org_id=p_org_id and invoice_id=p_invoice_id;

  insert into payments(org_id,invoice_id,amount_cents,currency,method,reference,received_at,raw)
    values(p_org_id,p_invoice_id,p_amount_cents,v_invoice.currency,'bank_transfer',v_reference,p_received_at,
      jsonb_build_object('recorded_by',trim(p_actor_email),'actor_id',p_actor_id))
    on conflict (org_id,invoice_id,reference) where reference is not null do nothing
    returning id into v_payment_id;

  if v_payment_id is null then
    -- Adopt: the same reference on the same invoice is a retry, not a second transfer —
    -- but only when it says the same thing. The stranded-payment case (inserted, not
    -- posted) is completed by the post below, the 0018 self-heal.
    v_was_existing:=true;
    select * into v_stored from payments where org_id=p_org_id and invoice_id=p_invoice_id and reference=v_reference;
    if v_stored.amount_cents is distinct from p_amount_cents or v_stored.received_at is distinct from p_received_at then
      raise exception 'this reference conflicts with the stored payment for this invoice'; end if;
    v_payment_id:=v_stored.id;
  else
    if p_amount_cents > v_invoice.total_cents - v_paid then
      raise exception 'payment exceeds what is outstanding on this invoice'; end if;
  end if;

  select t.invoice_state into v_state from post_payment_received(p_org_id,v_payment_id) t;

  if not v_was_existing then
    insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
      values(p_org_id,'operator','payments.record','payments.record','payment',v_payment_id,'notify','success',jsonb_build_object(
        'actor_id',p_actor_id,'actor_email',trim(p_actor_email),'invoice_id',p_invoice_id,'amount_cents',p_amount_cents::text,
        'reference',v_reference,'received_at',p_received_at,'invoice_state',v_state));
  end if;
  return query select v_payment_id,v_state,v_was_existing;
end $$;

do $$ declare r text; f regprocedure; begin
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('operator_record_payment') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
