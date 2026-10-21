-- AI-01: the worker narrates the day over the deterministic rollup (PLAN PR-S: the first
-- production Claude call; it never computes figures). This stores each narration attempt
-- with the exact snapshot it was grounded in, runs it as a JOBS-01 job
-- (kind daily_briefing), and gates it on the business's own assistant.narrate grant —
-- which is never seeded, because this bootstrap grants no model-spending budget. The
-- dashboard stays fully deterministic; a missing or stale briefing is an explicit state.

create table daily_briefings (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  generated_at timestamptz not null default now(),
  model text not null check(length(model)>0),
  -- The deterministic facts the narration was grounded in, verbatim.
  snapshot jsonb not null check(jsonb_typeof(snapshot)='object'),
  narration text,
  refs jsonb not null default '[]' check(jsonb_typeof(refs)='array'),
  -- ok: narration passed the grounding checks; rejected: it did not, and error says why.
  status text not null check(status in ('ok','rejected')),
  error text,
  check((status='ok') = (narration is not null and length(narration)>0)),
  check((status='rejected') = (error is not null))
);
create index daily_briefings_latest on daily_briefings(org_id,status,generated_at desc);
create trigger daily_briefings_immutable before update or delete on daily_briefings
  for each row execute function reject_dispatch_history_mutation();

-- The worker records every attempt, grounded or rejected, with an audit row.
create function record_daily_briefing(p_org_id uuid,p_model text,p_snapshot jsonb,
  p_narration text,p_refs jsonb,p_status text,p_error text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid;
begin
  if not exists(select 1 from orgs where id=p_org_id) then raise exception 'business unavailable'; end if;
  insert into daily_briefings(org_id,model,snapshot,narration,refs,status,error)
    values(p_org_id,p_model,p_snapshot,p_narration,coalesce(p_refs,'[]'::jsonb),p_status,p_error)
    returning id into v_id;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'assistant','assistant.narrate','assistant.narrate','daily_briefing',v_id,'notify',
      case when p_status='ok' then 'success'::audit_outcome else 'failure'::audit_outcome end,
      jsonb_build_object('briefing_id',v_id,'model',p_model,'status',p_status,'error',p_error));
  return v_id;
end $$;

-- Narration is wanted while the business has switched it on and today's grounded briefing
-- does not exist yet. The grant is the business's model-spend switch; it is never seeded.
create function daily_briefing_needed(p_org_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from tool_grants g where g.org_id=p_org_id and g.agent_name='assistant'
      and g.tool_name='assistant.narrate' and g.enabled)
    and not coalesce((select paused from action_controls where org_id=p_org_id),false)
    and not exists(select 1 from daily_briefings b where b.org_id=p_org_id and b.status='ok'
      and b.generated_at>now()-interval '24 hours')
$$;

alter table scheduled_jobs drop constraint scheduled_jobs_kind_check;
alter table scheduled_jobs add constraint scheduled_jobs_kind_check
  check(kind in ('carrier_cost_sync','invoice_part_draft','shopify_sync','approved_action_execute','daily_briefing'));
alter table scheduled_jobs drop constraint scheduled_jobs_dispatch_scope;
alter table scheduled_jobs add constraint scheduled_jobs_dispatch_scope check(
  case kind
    when 'carrier_cost_sync' then dispatch_id is not null and source_id is not null and action_id is null
    when 'invoice_part_draft' then dispatch_id is not null and source_id is not null and action_id is null
    when 'shopify_sync' then dispatch_id is null and source_id is not null and action_id is null
    when 'approved_action_execute' then dispatch_id is null and source_id is null and action_id is not null
    when 'daily_briefing' then dispatch_id is null and source_id is null and action_id is null
    else true end);

create or replace function scheduled_job_needed(j scheduled_jobs) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select case j.kind when 'carrier_cost_sync' then carrier_cost_job_needed(j.org_id,j.source_id,j.dispatch_id)
    when 'invoice_part_draft' then invoice_part_job_needed(j.org_id,j.source_id,j.dispatch_id)
    when 'shopify_sync' then shopify_sync_job_needed(j.org_id,j.source_id)
    when 'approved_action_execute' then approved_action_job_needed(j.org_id,j.action_id)
    when 'daily_briefing' then daily_briefing_needed(j.org_id) else false end
$$;

create function discover_daily_briefing_jobs(p_org_id uuid) returns integer
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_count integer; j scheduled_jobs%rowtype;
begin
  for j in select * from scheduled_jobs where org_id=p_org_id and kind='daily_briefing' and state in ('pending','failed','blocked','quarantined')
    and not daily_briefing_needed(org_id) for update skip locked loop
    perform close_unneeded_job(j);
  end loop;
  with ins as (
    insert into scheduled_jobs(org_id,job_key,kind)
      select o.id,'daily-briefing:'||o.id,'daily_briefing' from orgs o
      where o.id=p_org_id and daily_briefing_needed(o.id)
    on conflict(org_id,job_key) do update set state='pending',attempts=0,next_attempt_at=now(),last_error=null,updated_at=now()
      where scheduled_jobs.state='succeeded'
    returning 1
  ) select count(*) into v_count from ins;
  return v_count;
end $$;

do $$ declare r text; f regprocedure; begin
  execute 'alter table daily_briefings enable row level security';
  execute 'revoke all on table daily_briefings from public';
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on table daily_briefings from %I',r);
      if r='service_role' then execute 'grant select on table daily_briefings to service_role'; end if;
    end if;
  end loop;
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('record_daily_briefing','daily_briefing_needed','discover_daily_briefing_jobs') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        -- The worker discovers and records; the need check is internal.
        if r='service_role' and f::text not like 'daily_briefing_needed%' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
