-- FLOW-01B-b: customer receipts in the bank source (0051) matched to the invoices they
-- pay. The console proposes matches (an invoice number in the line's reference or
-- description, or the outstanding amount alone, which only ever makes a candidate); the
-- operator confirms each one, and confirming records the payment exactly once through
-- operator_record_payment (0043), which keeps owning the invoice rules: the
-- payments.record grant (never seeded), the issued/partial state, the outstanding cap
-- and the posting. The allocation adds the bank rules on top: only a credit line pays,
-- in its own currency, never beyond what remains unallocated on it, and the same line
-- and invoice pair is one payment (an exact retry adopts it). The payment's reference
-- names the bank line, so the invoice page shows where the money came from.
--
-- A credit line that is not a customer receipt (an owner's transfer, a refund received)
-- is marked so with a reason, and can be reopened; both are append-only history, and a
-- line that already pays an invoice cannot be marked. Debit lines are outside the
-- Controller's scope: they wait for the Bookkeeper module (PLAN D18). bank.review is
-- seeded notify-tier: classifying evidence moves no money. Service-role only.

alter table payments add constraint payments_org_id_key unique (org_id, id);

create table bank_receipt_allocations (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete restrict,
  bank_transaction_id uuid not null,
  invoice_id uuid not null,
  payment_id uuid not null,
  amount_cents bigint not null check (amount_cents > 0),
  allocated_by text not null,
  actor_id uuid not null,
  created_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, bank_transaction_id, invoice_id),
  unique (org_id, payment_id),
  foreign key (org_id, bank_transaction_id) references bank_transactions(org_id, id) on delete restrict,
  foreign key (org_id, invoice_id) references invoices(org_id, id) on delete restrict,
  foreign key (org_id, payment_id) references payments(org_id, id) on delete restrict
);
create index bank_receipt_allocations_line on bank_receipt_allocations(org_id, bank_transaction_id);
comment on table bank_receipt_allocations is
  'Money from a credit bank line applied to an invoice (0052): one payment per line and invoice. Append-only.';

create table bank_line_reviews (
  id uuid primary key default gen_random_uuid(),
  -- Decision order: timestamps can tie within a transaction, this cannot.
  seq bigint generated always as identity,
  org_id uuid not null references orgs(id) on delete restrict,
  bank_transaction_id uuid not null,
  decision text not null check (decision in ('not_receipt','reopened')),
  reason text not null check (reason = trim(reason) and length(reason) between 3 and 500),
  decided_by text not null,
  actor_id uuid not null,
  created_at timestamptz not null default now(),
  unique (org_id, id),
  foreign key (org_id, bank_transaction_id) references bank_transactions(org_id, id) on delete restrict
);
create index bank_line_reviews_line on bank_line_reviews(org_id, bank_transaction_id, seq desc);
comment on table bank_line_reviews is
  'A credit bank line marked as not a customer receipt, or reopened, with the reason (0052). The highest seq is the current state. Append-only.';

create trigger bank_receipt_allocations_append_only before update or delete on bank_receipt_allocations
  for each row execute function bank_evidence_append_only();
create trigger bank_line_reviews_append_only before update or delete on bank_line_reviews
  for each row execute function bank_evidence_append_only();

do $$ declare t text; r text; begin
  foreach t in array array['bank_receipt_allocations','bank_line_reviews'] loop
    execute format('alter table %I enable row level security',t);
    execute format('revoke all on %I from public',t);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on %I from %I',t,r);
        if r='service_role' then execute format('grant select on %I to service_role',t); end if;
      end if;
    end loop;
  end loop;
end $$;

create function operator_allocate_bank_receipt(p_org_id uuid,p_bank_transaction_id uuid,p_invoice_id uuid,
  p_amount_cents bigint,p_actor_id uuid,p_actor_email text)
returns table(oab_allocation_id uuid,oab_payment_id uuid,oab_invoice_state invoice_state,oab_remaining_cents bigint,oab_was_existing boolean)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_line bank_transactions%rowtype; v_invoice invoices%rowtype; v_alloc bank_receipt_allocations%rowtype;
  v_allocated bigint; v_review text; v_id uuid; r record;
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','payments.record');
  if p_amount_cents is null or p_amount_cents<=0 then raise exception 'payment amount must be positive'; end if;
  select * into v_line from bank_transactions where org_id=p_org_id and id=p_bank_transaction_id;
  if not found then raise exception 'bank line not found'; end if;
  -- One decision per bank line at a time: allocations and reviews take the same lock.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':bank-line:'||v_line.id::text,0));
  if v_line.amount_cents<=0 then raise exception 'only a credit bank line can pay an invoice'; end if;
  select decision into v_review from bank_line_reviews where org_id=p_org_id and bank_transaction_id=v_line.id
    order by seq desc limit 1;
  if v_review='not_receipt' then raise exception 'this bank line is marked as not a receipt'; end if;
  select * into v_invoice from invoices where org_id=p_org_id and id=p_invoice_id;
  if not found then raise exception 'invoice not found'; end if;
  if v_invoice.currency::text<>v_line.currency::text then raise exception 'the bank line and the invoice are in different currencies'; end if;

  select coalesce(sum(amount_cents),0) into v_allocated from bank_receipt_allocations
    where org_id=p_org_id and bank_transaction_id=v_line.id;
  -- The same line paying the same invoice is one payment: an exact retry adopts it.
  select * into v_alloc from bank_receipt_allocations where org_id=p_org_id and bank_transaction_id=v_line.id and invoice_id=p_invoice_id;
  if found then
    if v_alloc.amount_cents<>p_amount_cents then raise exception 'this bank line already pays this invoice a different amount'; end if;
    return query select v_alloc.id,v_alloc.payment_id,(select state from invoices where org_id=p_org_id and id=p_invoice_id),
      v_line.amount_cents-v_allocated,true;
    return;
  end if;
  if p_amount_cents>v_line.amount_cents-v_allocated then raise exception 'payment exceeds what remains on this bank line'; end if;

  -- The payment entry owns the invoice rules: grant, state, outstanding cap, exactly-once posting.
  select * into r from operator_record_payment(p_org_id,p_invoice_id,p_amount_cents,(v_line.posted_on::timestamp at time zone 'UTC'),
    format('Bank %s · %s',v_line.posted_on,v_line.id),p_actor_id,p_actor_email);
  insert into bank_receipt_allocations(org_id,bank_transaction_id,invoice_id,payment_id,amount_cents,allocated_by,actor_id)
    values(p_org_id,v_line.id,p_invoice_id,r.orp_payment_id,p_amount_cents,trim(p_actor_email),p_actor_id)
    returning id into v_id;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','bank.allocate','payments.record','bank_transaction',v_line.id,'notify','success',jsonb_build_object(
      'actor_id',p_actor_id,'actor_email',trim(p_actor_email),'allocation_id',v_id,'invoice_id',p_invoice_id,
      'payment_id',r.orp_payment_id,'amount_cents',p_amount_cents::text,'invoice_state',r.orp_invoice_state));
  return query select v_id,r.orp_payment_id,r.orp_invoice_state,v_line.amount_cents-v_allocated-p_amount_cents,false;
end $$;

create function operator_review_bank_line(p_org_id uuid,p_bank_transaction_id uuid,p_decision text,p_reason text,
  p_actor_id uuid,p_actor_email text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_line bank_transactions%rowtype; v_latest bank_line_reviews%rowtype; v_reason text:=trim(coalesce(p_reason,'')); v_risk text; v_id uuid;
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','bank.review');
  select risk into v_risk from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='bank.review' and enabled;
  if v_risk='approve_required' then raise exception 'reviewing a bank line cannot itself require an approval; its grant must not require approval'; end if;
  if p_decision is null or p_decision not in ('not_receipt','reopened') then raise exception 'bank line decision required'; end if;
  if length(v_reason)<3 or length(v_reason)>500 then raise exception 'a reason is required'; end if;
  select * into v_line from bank_transactions where org_id=p_org_id and id=p_bank_transaction_id;
  if not found then raise exception 'bank line not found'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':bank-line:'||v_line.id::text,0));
  select * into v_latest from bank_line_reviews where org_id=p_org_id and bank_transaction_id=v_line.id
    order by seq desc limit 1;
  if p_decision='not_receipt' then
    if v_line.amount_cents<=0 then raise exception 'only a credit bank line can be marked as not a receipt'; end if;
    if exists(select 1 from bank_receipt_allocations where org_id=p_org_id and bank_transaction_id=v_line.id) then
      raise exception 'this bank line already pays an invoice'; end if;
    if v_latest.decision='not_receipt' then
      -- An exact retry returns the stored decision; anything else is already decided.
      if v_latest.reason=v_reason then return v_latest.id; end if;
      raise exception 'this bank line is already marked as not a receipt';
    end if;
  elsif v_latest.decision is distinct from 'not_receipt' then
    raise exception 'this bank line is not marked as not a receipt';
  end if;
  insert into bank_line_reviews(org_id,bank_transaction_id,decision,reason,decided_by,actor_id)
    values(p_org_id,v_line.id,p_decision,v_reason,trim(p_actor_email),p_actor_id) returning id into v_id;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','bank.review','bank.review','bank_transaction',v_line.id,'notify','success',jsonb_build_object(
      'actor_id',p_actor_id,'actor_email',trim(p_actor_email),'decision',p_decision,'reason',v_reason,'review_id',v_id));
  return v_id;
end $$;

do $$ declare r text; f regprocedure; begin
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('operator_allocate_bank_receipt','operator_review_bank_line') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
