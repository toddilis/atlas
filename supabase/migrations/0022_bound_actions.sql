-- AUTHZ-02: persisted immutable tool intent, approval decisions and durable attempts.
-- Only service RPCs mutate this substrate; caller authority is derived at API/job boundary.
create table action_controls (
  org_id uuid primary key references orgs(id), paused boolean not null default false,
  changed_by text not null, reason text not null, changed_at timestamptz not null default now()
);
create table approved_actions (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references orgs(id),
  approval_id uuid not null unique references approvals(id), revision integer not null default 1 check (revision=1),
  intent jsonb not null check (jsonb_typeof(intent)='object'), intent_hash text not null,
  idempotency_key text not null, state text not null default 'PREPARED'
    check (state in ('PREPARED','AUTHORISED','EXECUTING','CONFIRMED','FAILED','UNRESOLVED','RECONCILIATION_REQUIRED')),
  revoked_at timestamptz, created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  unique(org_id,id), unique(org_id,idempotency_key)
);
create table action_attempts (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references orgs(id),
  action_id uuid not null, attempt_number integer not null check (attempt_number>0),
  state text not null check(state in ('EXECUTING','CONFIRMED','FAILED','UNRESOLVED','RECONCILIATION_REQUIRED')),
  started_at timestamptz not null default now(), finished_at timestamptz,
  result jsonb, evidence jsonb, error text, actor_id text not null,
  foreign key(org_id,action_id) references approved_actions(org_id,id), unique(action_id,attempt_number)
);
alter table approved_actions enable row level security;
alter table action_attempts enable row level security;
alter table action_controls enable row level security;
revoke all on approved_actions,action_attempts,action_controls from public,anon,authenticated,service_role;
grant select on approved_actions,action_attempts,action_controls to service_role;
revoke update,delete on approvals from anon,authenticated,service_role;

create function bound_action_immutable() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if tg_op='DELETE' then raise exception 'action evidence cannot be deleted'; end if;
  if row(new.org_id,new.approval_id,new.revision,new.intent,new.intent_hash,new.idempotency_key,new.created_at)
    is distinct from row(old.org_id,old.approval_id,old.revision,old.intent,old.intent_hash,old.idempotency_key,old.created_at)
    then raise exception 'approved intent is immutable; prepare a new action'; end if;
  return new;
end $$;
create trigger approved_actions_immutable before update or delete on approved_actions for each row execute function bound_action_immutable();
create function bound_approval_immutable() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if exists(select 1 from approved_actions where approval_id=old.id) then
    if tg_op='DELETE' then raise exception 'bound approval cannot be deleted'; end if;
    if row(new.org_id,new.agent_name,new.action,new.subject_type,new.subject_id,new.payload,new.expires_at)
       is distinct from row(old.org_id,old.agent_name,old.action,old.subject_type,old.subject_id,old.payload,old.expires_at)
      then raise exception 'bound approval intent/expiry is immutable'; end if;
    if old.state <> 'pending' and new.state<>old.state then raise exception 'approval disposition is final; revoke instead'; end if;
  end if;
  return new;
end $$;
create trigger approvals_bound_immutable before update or delete on approvals for each row execute function bound_approval_immutable();

create function current_action_policy(p_org_id uuid,p_tool text) returns jsonb language sql stable security definer
set search_path=pg_catalog,public as $$
 select coalesce((select jsonb_build_object('id',id,'version',version,'config',config)
 from policy_rules where org_id=p_org_id and scope_action=p_tool and enabled),'null'::jsonb)
$$;

create function assert_action_authority(p_org_id uuid,p_agent text,p_tool text) returns void language plpgsql security definer
set search_path=pg_catalog,public as $$
begin
 if coalesce((select paused from action_controls where org_id=p_org_id),false) then raise exception 'business actions paused'; end if;
 if exists(select 1 from agents where org_id=p_org_id and name=p_agent and not enabled) then raise exception 'agent disabled'; end if;
 if not exists(select 1 from tool_grants where org_id=p_org_id and agent_name=p_agent and tool_name=p_tool and enabled)
 then raise exception 'tool entitlement missing or revoked'; end if;
end $$;

-- All numeric money is text in the snapshot; PostgreSQL JSON numeric bigint otherwise
-- loses precision after ordinary JSON.parse in JS. Include line details and terms.
create function invoice_action_snapshot(p_org_id uuid,p_invoice_id uuid) returns jsonb language sql stable security definer
set search_path=pg_catalog,public as $$
 select jsonb_build_object('invoice',to_jsonb(i)||jsonb_build_object(
   'subtotal_cents',i.subtotal_cents::text,'tax_cents',i.tax_cents::text,'total_cents',i.total_cents::text),
   'lines',coalesce((select jsonb_agg(to_jsonb(l)||jsonb_build_object('unit_price_cents',l.unit_price_cents::text,
     'total_cents',l.total_cents::text,'quantity',l.quantity::text) order by l.id)
     from invoice_lines l where l.org_id=p_org_id and l.invoice_id=i.id),'[]'::jsonb))
 from invoices i where i.org_id=p_org_id and i.id=p_invoice_id
$$;

create function create_bound_approval(p_org_id uuid,p_intent jsonb,p_expires_at timestamptz,p_summary text default null)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_approval uuid; v_action uuid:=gen_random_uuid(); v_subject uuid; v_policy jsonb;
begin
 if p_org_id is null or p_intent->>'org_id' is distinct from p_org_id::text or p_intent->>'schema_version' is distinct from '1'
 or coalesce(p_intent->>'tool_name','')='' or coalesce(p_intent->>'agent_name','')='' or
 jsonb_typeof(p_intent->'input') is distinct from 'object' or
 jsonb_typeof(p_intent->'subject_snapshot') is distinct from 'object'
 then raise exception 'invalid bound action intent'; end if;
 if p_expires_at is null or p_expires_at<=clock_timestamp() then raise exception 'future approval expiry required'; end if;
 v_subject:=(p_intent->>'subject_id')::uuid;
 perform assert_action_authority(p_org_id,p_intent->>'agent_name',p_intent->>'tool_name');
 v_policy:=current_action_policy(p_org_id,p_intent->>'tool_name');
 if v_policy is distinct from p_intent->'policy_snapshot' then raise exception 'policy changed during preparation'; end if;
 if p_intent->>'tool_name'='controller.issue_invoice' then
   if p_intent->>'subject_type'<>'invoice' or v_subject is null or
      invoice_action_snapshot(p_org_id,v_subject) is distinct from p_intent->'subject_snapshot'
   then raise exception 'invoice snapshot changed or wrong business'; end if;
 end if;
 insert into approvals(org_id,agent_name,action,subject_type,subject_id,payload,proposed_summary,risk,expires_at)
 values(p_org_id,p_intent->>'agent_name',p_intent->>'tool_name',p_intent->>'subject_type',v_subject,p_intent,p_summary,'approve_required',p_expires_at)
 returning id into v_approval;
 insert into approved_actions(id,org_id,approval_id,intent,intent_hash,idempotency_key)
 values(v_action,p_org_id,v_approval,p_intent,encode(digest(p_intent::text,'sha256'),'hex'),p_org_id::text||':'||v_action::text||':1');
 insert into audit_log(org_id,agent_name,action,approval_id,risk,outcome,detail)
 values(p_org_id,p_intent->>'agent_name','action.prepared',v_approval,'approve_required','blocked',
 jsonb_build_object('action_id',v_action,'revision',1,'intent',p_intent));
 return v_approval;
end $$;

create function decide_bound_approval(p_org_id uuid,p_approval_id uuid,p_disposition text,p_actor text,p_reason text default null)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare a approvals%rowtype; v_action approved_actions%rowtype;
begin
 if coalesce(trim(p_actor),'')='' or p_disposition not in ('approved','rejected') then raise exception 'invalid approval decision'; end if;
 select * into v_action from approved_actions where org_id=p_org_id and approval_id=p_approval_id for update;
 if not found then raise exception 'legacy/unbound approval must be prepared again'; end if;
 select * into a from approvals where org_id=p_org_id and id=p_approval_id for update;
 if a.state<>'pending' or a.expires_at<=clock_timestamp() or v_action.revoked_at is not null then raise exception 'approval is not pending or has expired/revoked'; end if;
 if p_disposition='approved' then
   perform assert_action_authority(p_org_id,a.agent_name,a.action);
   if current_action_policy(p_org_id,a.action) is distinct from v_action.intent->'policy_snapshot' then raise exception 'policy changed; prepare again'; end if;
 end if;
 update approvals set state=p_disposition::approval_state,decided_by=p_actor,decided_at=now(),reason=p_reason where id=a.id;
 if p_disposition='approved' then update approved_actions set state='AUTHORISED',updated_at=now() where id=v_action.id; end if;
 insert into audit_log(org_id,agent_name,action,approval_id,risk,outcome,detail)
 values(p_org_id,a.agent_name,'approval.'||p_disposition,a.id,'approve_required','blocked',jsonb_build_object('action_id',v_action.id,'actor',p_actor,'reason',p_reason));
end $$;

create function claim_bound_action(p_org_id uuid,p_approval_id uuid,p_actor text,p_policy_snapshot jsonb,p_subject_snapshot jsonb)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare a approvals%rowtype; v approved_actions%rowtype; v_attempt uuid; v_number integer;
begin
 if coalesce(trim(p_actor),'')='' then raise exception 'trusted actor required'; end if;
 select * into v from approved_actions where org_id=p_org_id and approval_id=p_approval_id for update;
 if not found then raise exception 'bound action not found'; end if;
 select * into a from approvals where org_id=p_org_id and id=p_approval_id for update;
 if a.state<>'approved' or a.expires_at<=clock_timestamp() or v.revoked_at is not null then raise exception 'approval not valid'; end if;
 if v.state not in ('AUTHORISED','FAILED') then raise exception 'action already claimed or unresolved; reconcile first'; end if;
 perform assert_action_authority(p_org_id,a.agent_name,a.action);
 if current_action_policy(p_org_id,a.action) is distinct from v.intent->'policy_snapshot' or
    coalesce(p_policy_snapshot,'null'::jsonb) is distinct from v.intent->'policy_snapshot' then raise exception 'policy changed; prepare again'; end if;
 if p_subject_snapshot is distinct from v.intent->'subject_snapshot' then raise exception 'subject changed; prepare again'; end if;
 if a.action='controller.issue_invoice' then
   perform 1 from invoices where org_id=p_org_id and id=a.subject_id for update;
   if invoice_action_snapshot(p_org_id,a.subject_id) is distinct from p_subject_snapshot then raise exception 'invoice changed before claim'; end if;
 end if;
 select coalesce(max(attempt_number),0)+1 into v_number from action_attempts where action_id=v.id;
 insert into action_attempts(org_id,action_id,attempt_number,state,actor_id) values(p_org_id,v.id,v_number,'EXECUTING',p_actor) returning id into v_attempt;
 update approvals set executed_at=coalesce(executed_at,now()) where id=a.id;
 update approved_actions set state='EXECUTING',updated_at=now() where id=v.id;
 insert into audit_log(org_id,agent_name,action,approval_id,risk,outcome,detail)
 values(p_org_id,a.agent_name,'action.execution_started',a.id,'approve_required','blocked',jsonb_build_object('action_id',v.id,'execution_id',v_attempt,'actor',p_actor,'attempt',v_number));
 return jsonb_build_object('action_id',v.id,'execution_id',v_attempt,'idempotency_key',v.idempotency_key,'intent',v.intent);
end $$;

create function finish_bound_action(p_org_id uuid,p_action_id uuid,p_execution_id uuid,p_state text,p_result jsonb,p_evidence jsonb,p_error text default null)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare v approved_actions%rowtype; e action_attempts%rowtype;
begin
 select * into v from approved_actions where org_id=p_org_id and id=p_action_id for update;
 if not found then raise exception 'bound action not found'; end if;
 select * into e from action_attempts where org_id=p_org_id and action_id=v.id and id=p_execution_id for update;
 if not found then raise exception 'attempt not found'; end if;
 if e.state=p_state and e.result is not distinct from p_result and e.evidence is not distinct from p_evidence and e.error is not distinct from p_error then return; end if;
 if e.state<>'EXECUTING' or v.state<>'EXECUTING' or p_state not in ('CONFIRMED','FAILED','UNRESOLVED') then raise exception 'invalid completion transition'; end if;
 if p_state in ('CONFIRMED','FAILED') and (jsonb_typeof(p_evidence) is distinct from 'object' or p_evidence='{}'::jsonb)
 then raise exception 'known result requires confirmation/no-effect evidence'; end if;
 update action_attempts set state=p_state,result=p_result,evidence=p_evidence,error=p_error,finished_at=now() where id=e.id;
 update approved_actions set state=p_state,updated_at=now() where id=v.id;
 insert into audit_log(org_id,agent_name,action,approval_id,risk,outcome,detail)
 values(p_org_id,v.intent->>'agent_name','action.'||lower(p_state),v.approval_id,'approve_required',
 case when p_state='CONFIRMED' then 'success'::audit_outcome else 'failure'::audit_outcome end,
 jsonb_build_object('action_id',v.id,'execution_id',e.id,'result',p_result,'evidence',p_evidence,'error',p_error));
end $$;

create function reconcile_bound_action(p_org_id uuid,p_action_id uuid,p_state text,p_actor text,p_evidence jsonb)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare v approved_actions%rowtype; e action_attempts%rowtype;
begin
 if coalesce(trim(p_actor),'')='' or p_state not in ('CONFIRMED','FAILED') or jsonb_typeof(p_evidence) is distinct from 'object' or p_evidence='{}'::jsonb
 then raise exception 'reconciliation requires actor, known outcome and evidence'; end if;
 select * into v from approved_actions where org_id=p_org_id and id=p_action_id for update;
 if not found then raise exception 'action not found'; end if;
 if v.state not in ('EXECUTING','UNRESOLVED','RECONCILIATION_REQUIRED') then raise exception 'action not reconcilable'; end if;
 if v.state='EXECUTING' and v.updated_at>now()-interval '5 minutes' then raise exception 'active attempt cannot be reconciled'; end if;
 select * into e from action_attempts where org_id=p_org_id and action_id=v.id order by attempt_number desc limit 1 for update;
 update action_attempts set state=p_state,evidence=p_evidence,finished_at=now() where id=e.id;
 update approved_actions set state=p_state,updated_at=now() where id=v.id;
 insert into audit_log(org_id,agent_name,action,approval_id,risk,outcome,detail)
 values(p_org_id,v.intent->>'agent_name','action.reconciled',v.approval_id,'approve_required','blocked',
 jsonb_build_object('action_id',v.id,'execution_id',e.id,'state',p_state,'actor',p_actor,'evidence',p_evidence));
end $$;

create function revoke_bound_action(p_org_id uuid,p_action_id uuid,p_actor text,p_reason text) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v approved_actions%rowtype;
begin
 if coalesce(trim(p_actor),'')='' or coalesce(trim(p_reason),'')='' then raise exception 'actor and reason required'; end if;
 update approved_actions set revoked_at=coalesce(revoked_at,now()),updated_at=now() where org_id=p_org_id and id=p_action_id returning * into v;
 if not found then raise exception 'action not found'; end if;
 insert into audit_log(org_id,agent_name,action,approval_id,risk,outcome,detail) values(p_org_id,v.intent->>'agent_name','action.revoked',v.approval_id,
 'approve_required','blocked',jsonb_build_object('action_id',v.id,'actor',p_actor,'reason',p_reason));
end $$;

create function set_action_pause(p_org_id uuid,p_paused boolean,p_actor text,p_reason text) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if coalesce(trim(p_actor),'')='' or coalesce(trim(p_reason),'')='' then raise exception 'actor and reason required'; end if;
 insert into action_controls(org_id,paused,changed_by,reason) values(p_org_id,p_paused,p_actor,p_reason)
 on conflict(org_id) do update set paused=excluded.paused,changed_by=excluded.changed_by,reason=excluded.reason,changed_at=now();
 insert into audit_log(org_id,agent_name,action,risk,outcome,detail) values(p_org_id,p_actor,'actions.pause','approve_required','blocked',jsonb_build_object('paused',p_paused,'reason',p_reason));
end $$;

-- Lock the parent before changing invoice lines so the approved snapshot cannot race
-- the atomic issuance check. Existing settled-invoice immutability still applies.
create function lock_invoice_for_line_change() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
 perform 1 from invoices where id=coalesce(new.invoice_id,old.invoice_id) for update;
 if tg_op='DELETE' then return old; end if; return new;
end $$;
create trigger invoice_lines_action_lock before insert or update or delete on invoice_lines for each row execute function lock_invoice_for_line_change();

create function issue_bound_invoice(p_org_id uuid,p_action_id uuid,p_execution_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v approved_actions%rowtype; a approvals%rowtype; r record;
begin
 select * into v from approved_actions where org_id=p_org_id and id=p_action_id for update;
 if not found or v.intent->>'tool_name'<>'controller.issue_invoice' or v.state<>'EXECUTING' or v.revoked_at is not null then raise exception 'invalid invoice action'; end if;
 select * into a from approvals where org_id=p_org_id and id=v.approval_id;
 if a.state<>'approved' or a.expires_at<=clock_timestamp() then raise exception 'approval expired or invalid'; end if;
 if not exists(select 1 from action_attempts where org_id=p_org_id and action_id=v.id and id=p_execution_id and state='EXECUTING') then raise exception 'attempt not active'; end if;
 perform assert_action_authority(p_org_id,a.agent_name,a.action);
 if current_action_policy(p_org_id,a.action) is distinct from v.intent->'policy_snapshot' then raise exception 'policy changed'; end if;
 perform 1 from invoices where org_id=p_org_id and id=a.subject_id for update;
 if invoice_action_snapshot(p_org_id,a.subject_id) is distinct from v.intent->'subject_snapshot' then raise exception 'invoice changed'; end if;
 select * into r from issue_invoice_atomic(p_org_id,a.subject_id,v.idempotency_key);
 -- This confirms local issuance only. Legacy Stripe delivery remains held for explicit
 -- provider authorization; issuing locally never claims customer delivery.
 update outbox set state='failed',last_error='provider action requires separate bound authorization' where id=r.outbox_id and org_id=p_org_id;
 return to_jsonb(r);
end $$;

-- Service-only entry points, never directly callable by browser roles.
do $$ declare f record; begin
 for f in select p.oid::regprocedure as signature from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname in ('current_action_policy','assert_action_authority','invoice_action_snapshot',
 'create_bound_approval','decide_bound_approval','claim_bound_action','finish_bound_action','reconcile_bound_action','revoke_bound_action','set_action_pause','issue_bound_invoice')
 loop execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature); end loop;
end $$;
