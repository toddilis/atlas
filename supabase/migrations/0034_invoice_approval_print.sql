-- FLOW-01A for printed invoices (step 4b): the owner approves the exact invoice part they
-- see and Atlas issues it, then the printed document's outcome is recorded.
--
-- Approval and issuance are one transaction through the AUTHZ-02 bound-action path: the
-- page carries the digest of the invoice snapshot it showed; the database re-reads the
-- snapshot, refuses a changed one, prepares a bound action for exactly that snapshot,
-- records the operator's approval, claims it and issues the invoice with
-- issue_bound_invoice (which re-checks authority, policy caps and the subject, and posts
-- the ledger), then confirms the action. A refusal at any step leaves nothing behind.
-- The action runs as the business's operator under `controller.issue_invoice`; that grant
-- is never seeded, so a business turns invoice issuing on deliberately.
--
-- Issuing is not delivery. A printed outcome is recorded separately by a person, against
-- the stored document's digest, as printed or failed.

-- The digest of the exact invoice snapshot an approval binds; the console shows the page
-- with it and the approval refuses any other.
create function invoice_action_snapshot_digest(p_org_id uuid,p_invoice_id uuid) returns text
language sql stable security definer set search_path=pg_catalog,public as $$
  select encode(sha256(convert_to(invoice_action_snapshot(p_org_id,p_invoice_id)::text,'UTF8')),'hex')
$$;

create function operator_approve_invoice_part(p_org_id uuid,p_invoice_id uuid,p_expected_snapshot_sha text,
  p_actor_id uuid,p_actor_email text,p_note text default null) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare i invoices%rowtype; v_snapshot jsonb; v_policy jsonb; v_intent jsonb; v_approval uuid; v_claim jsonb; v_issue jsonb;
  v_note text:=nullif(trim(coalesce(p_note,'')),'');
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','controller.issue_invoice');
  select * into i from invoices where org_id=p_org_id and id=p_invoice_id for update;
  if not found then raise exception 'invoice not found'; end if;
  if not exists(select 1 from invoice_calculation_snapshots where org_id=p_org_id and invoice_id=i.id) then
    raise exception 'only invoice parts drafted from a dispatch can be approved here'; end if;
  if i.state<>'draft' then raise exception 'invoice is not a draft'; end if;
  v_snapshot:=invoice_action_snapshot(p_org_id,i.id);
  if invoice_action_snapshot_digest(p_org_id,i.id) is distinct from p_expected_snapshot_sha then
    raise exception 'invoice changed since it was loaded'; end if;
  v_policy:=current_action_policy(p_org_id,'controller.issue_invoice');
  v_intent:=jsonb_build_object('schema_version',1,'org_id',p_org_id,'agent_name','operator','tool_name','controller.issue_invoice',
    'subject_type','invoice','subject_id',i.id,
    'input',jsonb_build_object('invoiceId',i.id,'amount',jsonb_build_object('$atlas_bigint',i.total_cents::text),'currency',i.currency,
      'accountId',i.account_id,'fulfillmentEventId',i.fulfillment_event_id),
    'subject_snapshot',v_snapshot,'policy_snapshot',v_policy);
  v_approval:=create_bound_approval(p_org_id,v_intent,clock_timestamp()+interval '15 minutes',
    format('Issue invoice %s for %s %s',i.invoice_number,i.currency,to_char(i.total_cents/100.0,'FM999999999990.00')));
  perform decide_bound_approval(p_org_id,v_approval,'approved',trim(p_actor_email),v_note);
  v_claim:=claim_bound_action(p_org_id,v_approval,trim(p_actor_email),v_policy,v_snapshot);
  v_issue:=issue_bound_invoice(p_org_id,(v_claim->>'action_id')::uuid,(v_claim->>'execution_id')::uuid);
  perform finish_bound_action(p_org_id,(v_claim->>'action_id')::uuid,(v_claim->>'execution_id')::uuid,'CONFIRMED',v_issue,
    jsonb_build_object('effect','local_invoice_issued','invoice_number',i.invoice_number,
      'snapshot_sha256',p_expected_snapshot_sha,'approved_by',trim(p_actor_email),'delivery','not_confirmed'));
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,approval_id,risk,outcome,detail)
    values(p_org_id,'operator','invoices.approve','controller.issue_invoice','invoice',i.id,v_approval,'approve_required','success',
      jsonb_build_object('actor_id',p_actor_id,'actor_email',trim(p_actor_email),'note',v_note,'invoice_number',i.invoice_number,
        'total_cents',i.total_cents::text,'currency',i.currency,'snapshot_sha256',p_expected_snapshot_sha));
  return jsonb_build_object('approval_id',v_approval,'action_id',v_claim->>'action_id','issue',v_issue);
end $$;

-- A person's record of what happened to the printed document. Append-only; the latest
-- row is the current outcome, and every row stays as history.
create table invoice_print_outcomes (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references orgs(id),
  invoice_id uuid not null references invoices(id), outcome text not null check (outcome in ('printed','failed')),
  document_sha256 text not null, actor_id uuid not null, actor_email text not null check (length(actor_email)>0),
  note text, recorded_at timestamptz not null default now(),
  check (outcome<>'failed' or length(coalesce(note,''))>=3)
);
create index invoice_print_outcomes_invoice on invoice_print_outcomes(org_id,invoice_id,recorded_at);
create trigger invoice_print_outcomes_immutable before update or delete on invoice_print_outcomes
  for each row execute function reject_dispatch_history_mutation();

create function operator_record_invoice_print(p_org_id uuid,p_invoice_id uuid,p_outcome text,p_expected_document_sha text,
  p_actor_id uuid,p_actor_email text,p_note text default null) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare i invoices%rowtype; v_sha text; v_id uuid; v_note text:=nullif(trim(coalesce(p_note,'')),'');
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  if p_outcome not in ('printed','failed') then raise exception 'unknown print outcome'; end if;
  if p_outcome='failed' and length(coalesce(v_note,''))<3 then raise exception 'say what went wrong'; end if;
  perform assert_action_authority(p_org_id,'operator','invoices.record_print');
  select * into i from invoices where org_id=p_org_id and id=p_invoice_id for update;
  if not found then raise exception 'invoice not found'; end if;
  if i.state not in ('issued','paid','partial','overdue') then raise exception 'only an issued invoice can be printed'; end if;
  select content_hash into v_sha from invoice_calculation_snapshots where org_id=p_org_id and invoice_id=i.id;
  if v_sha is null then raise exception 'invoice has no stored document'; end if;
  if v_sha is distinct from p_expected_document_sha then raise exception 'document changed since it was loaded'; end if;
  insert into invoice_print_outcomes(org_id,invoice_id,outcome,document_sha256,actor_id,actor_email,note)
    values(p_org_id,i.id,p_outcome,v_sha,p_actor_id,trim(p_actor_email),v_note) returning id into v_id;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','invoices.record_print','invoices.record_print','invoice',i.id,'notify',
      case when p_outcome='printed' then 'success'::audit_outcome else 'failure'::audit_outcome end,
      jsonb_build_object('actor_id',p_actor_id,'actor_email',trim(p_actor_email),'outcome',p_outcome,'note',v_note,'document_sha256',v_sha));
  return v_id;
end $$;

do $$ declare r text; f regprocedure; begin
  alter table invoice_print_outcomes enable row level security;
  revoke all on table invoice_print_outcomes from public;
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on table invoice_print_outcomes from %I',r);
      if r='service_role' then execute 'grant select on table invoice_print_outcomes to service_role'; end if;
    end if;
  end loop;
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('invoice_action_snapshot_digest','operator_approve_invoice_part','operator_record_invoice_print') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
