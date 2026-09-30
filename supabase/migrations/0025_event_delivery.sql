-- EVENT-01. New canonical envelopes reuse the append-only spine; legacy handlers
-- never receive a domain event from this transport namespace. No business tools
-- run here: receipts may only commit the platform read projection below.
create table platform_events (
  org_id uuid not null references orgs(id), event_id text not null,
  log_id uuid not null unique references event_log(id), connection_key text not null,
  event_type text not null, source_key text not null, envelope jsonb not null,
  primary key(org_id,event_id), unique(org_id,connection_key,event_type,source_key)
);
create table event_receipts (
  org_id uuid not null, consumer text not null check(length(consumer)>0),
  generation text not null default 'live' check(length(generation)>0), event_id text not null,
  state text not null default 'pending' check(state in ('pending','processing','applied','ignored','failed','quarantined')),
  attempts integer not null default 0, lease_token uuid, lease_until timestamptz,
  next_attempt_at timestamptz not null default now(), reason text, owner text not null,
  updated_at timestamptz not null default now(),
  primary key(org_id,consumer,generation,event_id),
  foreign key(org_id,event_id) references platform_events(org_id,event_id)
);
create index event_receipts_work on event_receipts(org_id,consumer,generation,next_attempt_at)
  where state in ('pending','processing','failed');
create table event_read_models (
  org_id uuid not null, consumer text not null, generation text not null,
  connection_key text not null, subject_type text not null, subject_id text not null,
  subject_version bigint not null, event_id text not null, payload jsonb not null,
  updated_at timestamptz not null default now(),
  primary key(org_id,consumer,generation,connection_key,subject_type,subject_id),
  foreign key(org_id,event_id) references platform_events(org_id,event_id)
);
create trigger platform_events_immutable before update or delete on platform_events
  for each row execute function block_event_log_mutation();

-- All nested company-bearing references must agree, including payload references.
create function assert_evidence_company(p_org_id uuid,p_value jsonb) returns void
language plpgsql immutable set search_path=pg_catalog,public as $$
declare child jsonb;
begin
 if p_org_id is null then raise exception 'trusted company required'; end if;
 if jsonb_typeof(p_value)='object' then
   if p_value ? 'company_id' and p_value->>'company_id' is distinct from p_org_id::text then
     raise exception 'cross-company evidence reference'; end if;
   if p_value ? 'org_id' and p_value->>'org_id' is distinct from p_org_id::text then
     raise exception 'cross-company native record'; end if;
   for child in select value from jsonb_each(p_value) loop perform assert_evidence_company(p_org_id,child); end loop;
 elsif jsonb_typeof(p_value)='array' then
   for child in select value from jsonb_array_elements(p_value) loop perform assert_evidence_company(p_org_id,child); end loop;
 end if;
end $$;

create function supported_platform_event(p_envelope jsonb) returns boolean language sql immutable as $$
 select p_envelope->>'event_version'='1' and p_envelope->>'event_type' in (
 'controller.decision.proposed','controller.action.prepared','controller.action.execution_recorded','controller.outcome.recorded',
 'controller.invoice.drafted','platform.action.state_recorded','platform.approval.state_recorded','platform.attempt.state_recorded')
$$;

create function publish_platform_event(p_org_id uuid,p_envelope jsonb,p_source_key text,p_consumers text[] default '{}')
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare e platform_events%rowtype; v_log uuid; v_conn text; v_consumer text; v_id text; k text;
begin
 perform assert_evidence_company(p_org_id,p_envelope);
 if octet_length(p_envelope::text)>262144 then raise exception 'event exceeds 256 KiB'; end if;
 if jsonb_typeof(p_envelope) is distinct from 'object' or p_envelope->>'company_id' is distinct from p_org_id::text
 or coalesce(p_source_key,'')='' or jsonb_typeof(p_envelope->'payload') is distinct from 'object'
 or jsonb_typeof(p_envelope->'source_refs') is distinct from 'array'
 or jsonb_typeof(p_envelope->'evidence_refs') is distinct from 'array'
 or not (p_envelope ?& array['connection_id','causation_id'])
 or coalesce(p_envelope->>'event_class','') not in ('fact','detection','proposal')
 or coalesce(p_envelope->>'subject_version','') !~ '^[1-9][0-9]*$'
 or coalesce(p_envelope->>'event_version','') !~ '^[1-9][0-9]*$'
 then raise exception 'invalid event envelope'; end if;
 foreach k in array array['event_id','event_type','producer','subject_type','subject_id','correlation_id','occurred_at','observed_at'] loop
   if coalesce(p_envelope->>k,'')='' then raise exception 'missing event field %',k; end if;
 end loop;
 perform (p_envelope->>'occurred_at')::timestamptz,(p_envelope->>'observed_at')::timestamptz;
 v_id:=p_envelope->>'event_id';
 -- JSON text distinguishes null from every possible connection ID.
 v_conn:=(p_envelope->'connection_id')::text;
 -- Serialize both identities before INSERT (including concurrent conflicting deliveries).
 perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':event-publication',0));
 select * into e from platform_events where org_id=p_org_id and
   ((connection_key=v_conn and event_type=p_envelope->>'event_type' and source_key=p_source_key) or event_id=v_id);
 if found then
   if e.envelope is distinct from p_envelope or e.source_key<>p_source_key then raise exception 'conflicting event identity'; end if;
   v_log:=e.log_id;
 else
   if p_envelope->>'causation_id' is not null and not exists(select 1 from platform_events
     where org_id=p_org_id and event_id=p_envelope->>'causation_id') then raise exception 'missing or cross-company cause'; end if;
   insert into event_log(org_id,type,source,payload,occurred_at)
     values(p_org_id,'platform.envelope.v1',p_envelope->>'producer',p_envelope,(p_envelope->>'occurred_at')::timestamptz) returning id into v_log;
   insert into platform_events values(p_org_id,v_id,v_log,v_conn,p_envelope->>'event_type',p_source_key,p_envelope);
 end if;
 foreach v_consumer in array coalesce(p_consumers,'{}') loop
   if coalesce(trim(v_consumer),'')='' then raise exception 'consumer required'; end if;
   insert into event_receipts(org_id,consumer,event_id,owner,state,reason)
   values(p_org_id,v_consumer,v_id,v_consumer,
     case when supported_platform_event(p_envelope) then 'pending' else 'quarantined' end,
     case when not supported_platform_event(p_envelope) then 'unsupported event type/version; deploy compatible reader before resuming' end)
   on conflict do nothing;
 end loop;
 return v_log;
end $$;

-- Explicit replay is a fresh projection namespace, never an action retry.
create function enqueue_event_replay(p_org_id uuid,p_consumer text,p_generation text,p_event_ids text[]) returns integer
language plpgsql security definer set search_path=pg_catalog,public as $$
declare n integer;
begin
 if coalesce(trim(p_consumer),'')='' or coalesce(trim(p_generation),'')='' or p_generation='live' then raise exception 'named replay generation required'; end if;
 if exists(select 1 from unnest(p_event_ids) x where not exists(select 1 from platform_events where org_id=p_org_id and event_id=x))
 then raise exception 'missing or cross-company replay event'; end if;
 insert into event_receipts(org_id,consumer,generation,event_id,owner,state,reason)
 select p_org_id,p_consumer,p_generation,event_id,p_consumer,
 case when supported_platform_event(envelope) then 'pending' else 'quarantined' end,
 case when not supported_platform_event(envelope) then 'unsupported event type/version' end
 from platform_events where org_id=p_org_id and event_id=any(p_event_ids) on conflict do nothing;
 get diagnostics n=row_count; return n;
end $$;

create function claim_event_receipt(p_org_id uuid,p_consumer text,p_generation text default 'live') returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r event_receipts%rowtype;
begin
 -- A crash after the final claim must also reach a visible terminal state.
 update event_receipts set state='quarantined',reason='attempt limit; inspect and explicitly resume',lease_token=null,lease_until=null,updated_at=clock_timestamp()
 where org_id=p_org_id and consumer=p_consumer and generation=p_generation and attempts>=10
 and (state in ('pending','failed') or (state='processing' and lease_until<=clock_timestamp()));
 select * into r from event_receipts where org_id=p_org_id and consumer=p_consumer and generation=p_generation and attempts<10
 and ((state in ('pending','failed') and next_attempt_at<=clock_timestamp()) or (state='processing' and lease_until<=clock_timestamp()))
 order by next_attempt_at,event_id for update skip locked limit 1;
 if not found then return null; end if;
 update event_receipts set state='processing',attempts=attempts+1,lease_token=gen_random_uuid(),
 lease_until=clock_timestamp()+interval '60 seconds',updated_at=clock_timestamp()
 where org_id=r.org_id and consumer=r.consumer and generation=r.generation and event_id=r.event_id returning * into r;
 return to_jsonb(r)||jsonb_build_object('envelope',(select envelope from platform_events where org_id=r.org_id and event_id=r.event_id));
end $$;

-- Payload and version derive only from the persisted envelope. The receipt and
-- projection COMMIT together. There is no callback or RPC for arbitrary effects.
create function apply_event_projection(p_org_id uuid,p_consumer text,p_generation text,p_event_id text,p_lease_token uuid) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare r event_receipts%rowtype; e platform_events%rowtype; m event_read_models%rowtype; v bigint; s text; v_reason text;
begin
 select * into r from event_receipts where org_id=p_org_id and consumer=p_consumer and generation=p_generation and event_id=p_event_id for update;
 if not found then raise exception 'receipt not found'; end if;
 if r.state in ('applied','ignored') then return r.state; end if;
 if r.state<>'processing' or r.lease_token is distinct from p_lease_token or r.lease_until<=clock_timestamp() then raise exception 'stale receipt claim'; end if;
 select * into e from platform_events where org_id=p_org_id and event_id=p_event_id;
 v:=(e.envelope->>'subject_version')::bigint;
 perform pg_advisory_xact_lock(hashtextextended(jsonb_build_array(p_org_id,p_consumer,p_generation,e.connection_key,e.envelope->>'subject_type',e.envelope->>'subject_id')::text,0));
 select * into m from event_read_models where org_id=p_org_id and consumer=p_consumer and generation=p_generation
   and connection_key=e.connection_key and subject_type=e.envelope->>'subject_type' and subject_id=e.envelope->>'subject_id';
 if not supported_platform_event(e.envelope) then s:='quarantined'; v_reason:='unsupported event type/version';
 elsif found and v=m.subject_version and (m.event_id<>p_event_id or m.payload is distinct from e.envelope->'payload') then
   s:='quarantined'; v_reason:='conflicting same-version identity/content';
 elsif found and v<=m.subject_version then s:='ignored';
 elsif v<>coalesce(m.subject_version,0)+1 then
   s:=case when r.attempts>=10 then 'quarantined' else 'failed' end; v_reason:='missing predecessor; reconcile source before retry';
 else
   insert into event_read_models values(p_org_id,p_consumer,p_generation,e.connection_key,e.envelope->>'subject_type',e.envelope->>'subject_id',v,p_event_id,e.envelope->'payload',clock_timestamp())
   on conflict(org_id,consumer,generation,connection_key,subject_type,subject_id) do update
     set subject_version=excluded.subject_version,event_id=excluded.event_id,payload=excluded.payload,updated_at=excluded.updated_at;
   s:='applied';
 end if;
 update event_receipts set state=s,reason=v_reason,lease_token=null,lease_until=null,
   next_attempt_at=clock_timestamp()+make_interval(secs=>least(3600,power(2,r.attempts)::integer)),updated_at=clock_timestamp()
 where org_id=p_org_id and consumer=p_consumer and generation=p_generation and event_id=p_event_id;
 return s;
end $$;

create function resume_event_receipt(p_org_id uuid,p_consumer text,p_generation text,p_event_id text,p_actor text,p_reason text) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
 if coalesce(trim(p_actor),'')='' or coalesce(trim(p_reason),'')='' then raise exception 'resume actor and reason required'; end if;
 update event_receipts set state='pending',attempts=0,reason=p_reason,owner=p_actor,next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
 where org_id=p_org_id and consumer=p_consumer and generation=p_generation and event_id=p_event_id and state in ('failed','quarantined');
 if not found then raise exception 'receipt not resumable'; end if;
 insert into audit_log(org_id,agent_name,action,risk,outcome,detail) values(p_org_id,p_actor,'event.receipt.resumed','notify','blocked',
 jsonb_build_object('event_id',p_event_id,'consumer',p_consumer,'generation',p_generation,'reason',p_reason));
end $$;

create function read_event_delivery(p_org_id uuid,p_event_id text) returns jsonb language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('envelope',e.envelope,'receipts',coalesce((select jsonb_agg(to_jsonb(r)-'lease_token') from event_receipts r
 where r.org_id=e.org_id and r.event_id=e.event_id),'[]'::jsonb)) from platform_events e where e.org_id=p_org_id and e.event_id=p_event_id
$$;

alter table platform_events enable row level security;
alter table event_receipts enable row level security;
alter table event_read_models enable row level security;
revoke all on platform_events,event_receipts,event_read_models from public,anon,authenticated,service_role;
grant select on platform_events,event_receipts,event_read_models to service_role;
do $$ declare f record; begin
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('assert_evidence_company','supported_platform_event','publish_platform_event','enqueue_event_replay','claim_event_receipt','apply_event_projection','resume_event_receipt','read_event_delivery') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature); end loop;
end $$;
