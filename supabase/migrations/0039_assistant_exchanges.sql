-- AI-01 (PLAN PR-T): the read-only console assistant. An operator asks a question; the
-- console runs whitelisted read-only query tools and one bounded model loop, grounds the
-- answer in what the tools returned, and records the exchange here — question, answer,
-- the citations deterministic code built from the queries actually run, and who asked.
-- The operator's assistant.ask grant is the spend switch and is never seeded. The model
-- writes sentences; it holds no write tool and every figure is checked against the rows.

create table assistant_exchanges (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  asked_by_id uuid not null,
  asked_by_email text not null check(length(asked_by_email)>0),
  question text not null check(length(question) between 1 and 1000),
  answer text,
  -- What was actually queried to answer: built by code from the executed tool calls.
  citations jsonb not null default '[]' check(jsonb_typeof(citations)='array'),
  model text not null check(length(model)>0),
  status text not null check(status in ('ok','failed')),
  error text,
  created_at timestamptz not null default now(),
  check((status='ok') = (answer is not null and length(answer)>0)),
  check((status='failed') = (error is not null))
);
create index assistant_exchanges_latest on assistant_exchanges(org_id,created_at desc);
create trigger assistant_exchanges_immutable before update or delete on assistant_exchanges
  for each row execute function reject_dispatch_history_mutation();

create function record_assistant_exchange(p_org_id uuid,p_actor_id uuid,p_actor_email text,
  p_question text,p_answer text,p_citations jsonb,p_model text,p_status text,p_error text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid;
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','assistant.ask');
  if exists(select 1 from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='assistant.ask'
    and enabled and risk='approve_required') then
    raise exception 'asking the assistant cannot itself require an approval; its grant must not require approval'; end if;
  insert into assistant_exchanges(org_id,asked_by_id,asked_by_email,question,answer,citations,model,status,error)
    values(p_org_id,p_actor_id,trim(p_actor_email),p_question,p_answer,coalesce(p_citations,'[]'::jsonb),p_model,p_status,p_error)
    returning id into v_id;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','assistant.ask','assistant.ask','assistant_exchange',v_id,'notify',
      case when p_status='ok' then 'success'::audit_outcome else 'failure'::audit_outcome end,
      jsonb_build_object('exchange_id',v_id,'actor_id',p_actor_id,'actor_email',trim(p_actor_email),
        'model',p_model,'status',p_status,'error',p_error));
  return v_id;
end $$;

do $$ declare r text; f regprocedure:='record_assistant_exchange(uuid,uuid,text,text,text,jsonb,text,text,text)'::regprocedure; begin
  execute 'alter table assistant_exchanges enable row level security';
  execute 'revoke all on table assistant_exchanges from public';
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on table assistant_exchanges from %I',r);
      if r='service_role' then execute 'grant select on table assistant_exchanges to service_role'; end if;
    end if;
  end loop;
  execute format('revoke all on function %s from public',f);
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
      if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
    end if;
  end loop;
end $$;
