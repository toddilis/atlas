-- EVIDENCE-01 consumes AUTHZ-02 (0022); it never grants authority or executes tools.
create table evidence_observations (
 org_id uuid not null references orgs(id), observation_id text not null, record jsonb not null,
 facts jsonb not null, recorded_at timestamptz not null default now(), primary key(org_id,observation_id)
);
create table evidence_decisions (
 org_id uuid not null references orgs(id), decision_id text not null, revision integer not null check(revision>0),
 record jsonb not null, state_snapshot jsonb not null, snapshot_id text not null,
 snapshot_hash text not null, recorded_at timestamptz not null default now(),
 primary key(org_id,decision_id,revision), unique(org_id,snapshot_id)
);
create table evidence_action_links (
 org_id uuid not null, decision_id text not null, decision_revision integer not null, action_id uuid not null,
 linked_at timestamptz not null default now(), primary key(org_id,action_id),
 foreign key(org_id,decision_id,decision_revision) references evidence_decisions(org_id,decision_id,revision),
 foreign key(org_id,action_id) references approved_actions(org_id,id)
);
create table evidence_history (
 id uuid primary key default gen_random_uuid(), org_id uuid not null references orgs(id),
 action_id uuid not null, record_kind text not null check(record_kind in ('action','approval','attempt')),
 record_id uuid not null, record jsonb not null, recorded_at timestamptz not null default clock_timestamp(),
 capture_kind text not null default 'transition' check(capture_kind in ('transition','adoption_snapshot')),
 foreign key(org_id,action_id) references approved_actions(org_id,id)
);
create index evidence_history_chain on evidence_history(org_id,action_id,recorded_at);
create table evidence_outcomes (
 org_id uuid not null, outcome_id text not null, decision_id text not null, decision_revision integer not null,
 record jsonb not null, recorded_at timestamptz not null default now(), primary key(org_id,outcome_id),
 foreign key(org_id,decision_id,decision_revision) references evidence_decisions(org_id,decision_id,revision)
);

-- Strict internal native adapter validation is derived from actual persisted AUTH
-- rows. A caller cannot invent an action/attempt or relabel another company's row.
create function validate_native_evidence_event() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare h evidence_history%rowtype; p jsonb:=new.envelope->'payload';
begin
 if new.event_type like 'platform.%.state_recorded' then
   select * into h from evidence_history where org_id=new.org_id and id::text=new.envelope->>'subject_id';
   if not found or h.capture_kind<>'transition' or new.event_type<>'platform.'||h.record_kind||'.state_recorded'
   or new.envelope->>'event_class'<>'fact' or new.envelope->>'subject_type'<>'EvidenceRecord' or new.envelope->>'subject_version'<>'1'
   or new.envelope->>'correlation_id'<>h.action_id::text
   or p is distinct from jsonb_build_object('record_kind',h.record_kind,'record_id',h.record_id,'record',h.record)
   then raise exception 'invalid native evidence event'; end if;
 end if;
 return new;
end $$;
create trigger platform_native_evidence_validation before insert on platform_events for each row execute function validate_native_evidence_event();

create function record_evidence_observation(p_org_id uuid,p_record jsonb,p_facts jsonb) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare prior evidence_observations%rowtype; v_id text:=p_record->>'observation_id';
begin
 perform assert_evidence_company(p_org_id,p_record); perform assert_evidence_company(p_org_id,p_facts);
 if octet_length(p_record::text)+octet_length(p_facts::text)>262144 then raise exception 'observation exceeds 256 KiB'; end if;
 if p_record->>'company_id' is distinct from p_org_id::text or p_record->>'contract_version' is distinct from '1'
 or coalesce(v_id,'')='' or jsonb_typeof(p_facts) is distinct from 'object'
 or jsonb_typeof(p_record->'subject') is distinct from 'object'
 or coalesce(p_record->>'quality','') not in ('verified','unverified','stale','conflicting')
 then raise exception 'invalid observation'; end if;
 insert into evidence_observations(org_id,observation_id,record,facts) values(p_org_id,v_id,p_record,p_facts) on conflict do nothing;
 select * into prior from evidence_observations where org_id=p_org_id and observation_id=v_id;
 if prior.record is distinct from p_record or prior.facts is distinct from p_facts then raise exception 'conflicting observation identity'; end if;
 return v_id;
end $$;

create function record_evidence_decision(p_org_id uuid,p_record jsonb,p_state_snapshot jsonb) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare prior evidence_decisions%rowtype; ref jsonb; v_id text:=p_record->>'decision_id'; v_revision integer;
begin
 perform assert_evidence_company(p_org_id,p_record); perform assert_evidence_company(p_org_id,p_state_snapshot);
 if octet_length(p_record::text)+octet_length(p_state_snapshot::text)>262144 then raise exception 'decision exceeds 256 KiB'; end if;
 if p_record->>'company_id' is distinct from p_org_id::text or p_record->>'contract_version' is distinct from '1'
 or coalesce(v_id,'')='' or coalesce(p_record->>'revision','')!~'^[1-9][0-9]*$'
 or jsonb_typeof(p_state_snapshot) is distinct from 'object' or p_state_snapshot='{}'
 or coalesce(p_record#>>'{state_snapshot_ref,id}','')=''
 or jsonb_typeof(p_record->'trigger_refs') is distinct from 'array' or jsonb_array_length(p_record->'trigger_refs')=0
 then raise exception 'invalid decision snapshot'; end if;
 v_revision:=(p_record->>'revision')::integer;
 for ref in select value from jsonb_array_elements(p_record->'trigger_refs') loop
   if ref->>'type'='Observation' and not exists(select 1 from evidence_observations where org_id=p_org_id and observation_id=ref->>'id')
     then raise exception 'missing or cross-company observation'; end if;
 end loop;
 insert into evidence_decisions(org_id,decision_id,revision,record,state_snapshot,snapshot_id,snapshot_hash)
 values(p_org_id,v_id,v_revision,p_record,p_state_snapshot,p_record#>>'{state_snapshot_ref,id}',encode(digest(p_state_snapshot::text,'sha256'),'hex')) on conflict do nothing;
 select * into prior from evidence_decisions where org_id=p_org_id and decision_id=v_id and revision=v_revision;
 if not found or prior.record is distinct from p_record or prior.state_snapshot is distinct from p_state_snapshot then raise exception 'conflicting immutable decision snapshot'; end if;
 return v_id;
end $$;

create function link_decision_action(p_org_id uuid,p_decision_id text,p_revision integer,p_action_id uuid) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare d evidence_decisions%rowtype; a approved_actions%rowtype; prior evidence_action_links%rowtype;
begin
 select * into d from evidence_decisions where org_id=p_org_id and decision_id=p_decision_id and revision=p_revision;
 if not found then raise exception 'decision not found'; end if;
 select * into a from approved_actions where org_id=p_org_id and id=p_action_id;
 if not found then raise exception 'action not found'; end if;
 if not exists(select 1 from jsonb_array_elements(d.record->'subject_refs') r
   where r->>'id'=a.intent->>'subject_id' and lower(r->>'type')=lower(a.intent->>'subject_type'))
 then raise exception 'decision/action subject mismatch'; end if;
 insert into evidence_action_links(org_id,decision_id,decision_revision,action_id) values(p_org_id,p_decision_id,p_revision,p_action_id) on conflict do nothing;
 select * into prior from evidence_action_links where org_id=p_org_id and action_id=p_action_id;
 if prior.decision_id<>p_decision_id or prior.decision_revision<>p_revision then raise exception 'action already linked to another decision'; end if;
end $$;

create function record_evidence_outcome(p_org_id uuid,p_decision_revision integer,p_record jsonb) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id text:=p_record->>'outcome_id'; a text; prior jsonb;
begin
 perform assert_evidence_company(p_org_id,p_record);
 if octet_length(p_record::text)>262144 then raise exception 'outcome exceeds 256 KiB'; end if;
 if p_record->>'company_id' is distinct from p_org_id::text or p_record->>'contract_version' is distinct from '1'
 or coalesce(v_id,'')='' or coalesce(p_record->>'status','') not in ('known','unknown')
 or jsonb_typeof(p_record->'action_ids') is distinct from 'array' or jsonb_array_length(p_record->'action_ids')=0
 then raise exception 'invalid outcome'; end if;
 if p_record->>'status'='unknown' and (coalesce(p_record->>'unknown_reason','')='' or p_record->>'evaluation' is distinct from 'unavailable'
 or p_record->'metrics_after' is distinct from '[]'::jsonb or p_record->'observed_outcomes' is distinct from '[]'::jsonb
 or p_record->'measured_at' is distinct from 'null'::jsonb) then raise exception 'unknown outcome must remain unmeasured'; end if;
 if p_record->>'status'='known' and (p_record->>'measured_at' is null or coalesce(jsonb_array_length(p_record->'evidence_refs'),0)=0
 or coalesce(jsonb_array_length(p_record->'observed_outcomes'),0)=0 or p_record->'unknown_reason' is distinct from 'null'::jsonb
 or coalesce(p_record->>'evaluation','unavailable')='unavailable') then raise exception 'known outcome requires measured evidence'; end if;
 for a in select jsonb_array_elements_text(p_record->'action_ids') loop
 if not exists(select 1 from evidence_action_links where org_id=p_org_id and decision_id=p_record->>'decision_id'
 and decision_revision=p_decision_revision and action_id::text=a) then raise exception 'outcome action not linked to decision'; end if;
 end loop;
 insert into evidence_outcomes(org_id,outcome_id,decision_id,decision_revision,record)
 values(p_org_id,v_id,p_record->>'decision_id',p_decision_revision,p_record) on conflict do nothing;
 select record into prior from evidence_outcomes where org_id=p_org_id and outcome_id=v_id;
 if prior is distinct from p_record then raise exception 'conflicting outcome identity; append a correction'; end if;
 return v_id;
end $$;

-- Forward hooks capture actual AUTH state, not a fabricated Controller-v1 action.
-- Publication failure aborts the originating action/attempt/approval transaction.
create function capture_action_evidence() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare a uuid; kind text; h uuid; company uuid; rec jsonb; ts text; approval_rec jsonb;
begin
 rec:=to_jsonb(new); company:=(rec->>'org_id')::uuid;
 if tg_table_name='approved_actions' then a:=new.id; kind:='action';
 elsif tg_table_name='action_attempts' then a:=new.action_id; kind:='attempt';
 else select id into a from approved_actions where org_id=company and approval_id=new.id; kind:='approval';
   if a is null then return new; end if;
 end if;
 if tg_op='UPDATE' and (to_jsonb(old)-'updated_at')=(rec-'updated_at') then return new; end if;
 insert into evidence_history(org_id,action_id,record_kind,record_id,record) values(company,a,kind,(rec->>'id')::uuid,rec) returning id into h;
 ts:=to_char(clock_timestamp() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"');
 perform publish_platform_event(company,jsonb_build_object('event_id',h::text,'event_type','platform.'||kind||'.state_recorded',
 'event_version',1,'company_id',company,'connection_id',null,'occurred_at',ts,'observed_at',ts,'producer','evidence.authz-adapter',
 'subject_type','EvidenceRecord','subject_id',h::text,'subject_version',1,'correlation_id',a::text,'causation_id',null,
 'source_refs',jsonb_build_array(jsonb_build_object('company_id',company,'type',kind,'id',rec->>'id')),
 'evidence_refs',jsonb_build_array(jsonb_build_object('company_id',company,'type','EvidenceRecord','id',h)),
 'event_class','fact','payload',jsonb_build_object('record_kind',kind,'record_id',rec->>'id','record',rec)),h::text,array['evidence.authz']);
 -- The approval row predates the action INSERT; preserve that actual initial row too.
 if tg_table_name='approved_actions' and tg_op='INSERT' then
   select to_jsonb(p) into approval_rec from approvals p where p.org_id=company and p.id=new.approval_id;
   insert into evidence_history(org_id,action_id,record_kind,record_id,record) values(company,a,'approval',new.approval_id,approval_rec);
 end if;
 return new;
end $$;
create trigger approved_action_evidence after insert or update on approved_actions for each row execute function capture_action_evidence();
create trigger action_attempt_evidence after insert or update on action_attempts for each row execute function capture_action_evidence();
create trigger approval_evidence after update on approvals for each row execute function capture_action_evidence();

-- We know only current state at adoption. Never claim to reconstruct prior states.
insert into evidence_history(org_id,action_id,record_kind,record_id,record,capture_kind)
 select org_id,id,'action',id,to_jsonb(a),'adoption_snapshot' from approved_actions a;
insert into evidence_history(org_id,action_id,record_kind,record_id,record,capture_kind)
 select e.org_id,e.action_id,'attempt',e.id,to_jsonb(e),'adoption_snapshot' from action_attempts e;
insert into evidence_history(org_id,action_id,record_kind,record_id,record,capture_kind)
 select a.org_id,a.id,'approval',p.id,to_jsonb(p),'adoption_snapshot' from approved_actions a join approvals p on p.id=a.approval_id and p.org_id=a.org_id;

create function read_decision_evidence(p_org_id uuid,p_decision_id text,p_revision integer) returns jsonb
language sql stable security definer set search_path=pg_catalog,public as $$
 select jsonb_build_object('contract_version',1,'company_id',d.org_id,'decision',d.record,
 'state_at_decision',d.state_snapshot,'snapshot_hash',d.snapshot_hash,
 'observations',coalesce((select jsonb_agg(jsonb_build_object('record',o.record,'facts',o.facts)) from evidence_observations o
 where o.org_id=d.org_id and exists(select 1 from jsonb_array_elements(d.record->'trigger_refs') r where r->>'type'='Observation' and r->>'id'=o.observation_id)),'[]'::jsonb),
 'actions',coalesce((select jsonb_agg(jsonb_build_object('action',to_jsonb(a),'approval',to_jsonb(p),
 'execution_status',case when a.state='FAILED' then 'failed' when a.state='CONFIRMED' then 'confirmed'
   when a.state in ('UNRESOLVED','RECONCILIATION_REQUIRED') or (a.state='EXECUTING' and a.updated_at<=now()-interval '5 minutes') then 'unknown' else 'pending' end,
 'recovery',case when a.state in ('UNRESOLVED','RECONCILIATION_REQUIRED') or (a.state='EXECUTING' and a.updated_at<=now()-interval '5 minutes')
   then 'reconcile existing action; do not retry' else null end,
 'attempts',coalesce((select jsonb_agg(to_jsonb(e) order by attempt_number) from action_attempts e where e.org_id=a.org_id and e.action_id=a.id),'[]'::jsonb),
 'history',coalesce((select jsonb_agg(to_jsonb(h) order by recorded_at,id) from evidence_history h where h.org_id=a.org_id and h.action_id=a.id),'[]'::jsonb)))
 from evidence_action_links l join approved_actions a on a.org_id=l.org_id and a.id=l.action_id
 join approvals p on p.org_id=a.org_id and p.id=a.approval_id
 where l.org_id=d.org_id and l.decision_id=d.decision_id and l.decision_revision=d.revision),'[]'::jsonb),
 'outcomes',coalesce((select jsonb_agg(o.record order by recorded_at,outcome_id) from evidence_outcomes o
 where o.org_id=d.org_id and o.decision_id=d.decision_id and o.decision_revision=d.revision),'[]'::jsonb),
 'outcome_status',case when exists(select 1 from evidence_outcomes o where o.org_id=d.org_id and o.decision_id=d.decision_id and o.decision_revision=d.revision)
 then 'recorded; inspect individual measurement windows' else 'unknown' end,
 'missing_outcome_reason',case when not exists(select 1 from evidence_outcomes o where o.org_id=d.org_id and o.decision_id=d.decision_id and o.decision_revision=d.revision)
 then 'No measured business outcome recorded' else null end)
 from evidence_decisions d where d.org_id=p_org_id and d.decision_id=p_decision_id and d.revision=p_revision
$$;

do $$ declare t text; f record; begin
 foreach t in array array['evidence_observations','evidence_decisions','evidence_action_links','evidence_history','evidence_outcomes'] loop
 execute format('create trigger %I before update or delete on %I for each row execute function block_event_log_mutation()',t||'_immutable',t);
 execute format('alter table %I enable row level security',t);
 execute format('revoke all on %I from public,anon,authenticated,service_role',t);
 execute format('grant select on %I to service_role',t); end loop;
 for f in select oid::regprocedure signature from pg_proc where pronamespace='public'::regnamespace and proname in
 ('record_evidence_observation','record_evidence_decision','link_decision_action','record_evidence_outcome','capture_action_evidence','validate_native_evidence_event','read_decision_evidence') loop
 execute format('revoke all on function %s from public,anon,authenticated',f.signature);
 execute format('grant execute on function %s to service_role',f.signature); end loop;
end $$;
