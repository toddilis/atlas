-- JOBS-01 core: durable, business-scoped job records the worker discovers, leases, runs and
-- finishes without anyone calling an endpoint. A crashed run's lease expires and the job is
-- claimed again; a job that cannot proceed is visible as blocked with its reason, never a
-- silent success. First job kind: carrier cost sync for a dispatch's first invoice part.
create table scheduled_jobs (
  org_id uuid not null references orgs(id), job_key text not null check(length(job_key)>0),
  kind text not null check(kind in ('carrier_cost_sync')),
  source_id uuid not null, dispatch_id uuid not null,
  state text not null default 'pending' check(state in ('pending','running','succeeded','failed','blocked','quarantined')),
  attempts integer not null default 0 check(attempts>=0), next_attempt_at timestamptz not null default now(),
  lease_token uuid, lease_until timestamptz, last_error text,
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  primary key(org_id,job_key), foreign key(org_id,source_id,dispatch_id) references dispatches(org_id,source_id,id),
  check((state='running')=(lease_token is not null and lease_until is not null))
);
create index scheduled_jobs_due on scheduled_jobs(org_id,kind,next_attempt_at) where state in ('pending','failed','blocked','running');
-- One append-only row per finished attempt: what ran, when, and how it ended.
create table job_runs (
  id uuid primary key default gen_random_uuid(), org_id uuid not null, job_key text not null,
  attempt integer not null, started_at timestamptz not null, finished_at timestamptz not null default now(),
  outcome text not null check(outcome in ('succeeded','retry','blocked','lease_expired')), detail jsonb not null default '{}',
  foreign key(org_id,job_key) references scheduled_jobs(org_id,job_key)
);
create trigger job_runs_immutable before update or delete on job_runs for each row execute function reject_dispatch_history_mutation();

-- Work discovery: an eligible Shopify dispatch that is the first of its order still to bill,
-- has tracking numbers to look up, and no unexpired stored carrier cost. Idempotent; a
-- finished job whose recorded cost has since expired is re-armed while the part is unbilled.
create function discover_carrier_cost_jobs(p_org_id uuid) returns integer
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_count integer;
begin
  with due as (
    select d.org_id,d.source_id,d.id from dispatches d
    join dispatch_sources s on s.org_id=d.org_id and s.id=d.source_id and s.provider='shopify' and s.enabled
    join shopify_fulfillments f on f.org_id=d.org_id and f.dispatch_id=d.id and cardinality(f.tracking_numbers)>0
    where d.org_id=p_org_id and d.state='eligible'
      and not exists(select 1 from invoice_calculation_snapshots x join dispatches o on o.id=x.dispatch_id
        where x.org_id=d.org_id and x.source_id=d.source_id and o.order_key=d.order_key)
      and not exists(select 1 from carrier_cost_evidence e where e.org_id=d.org_id and e.dispatch_id=d.id and e.expires_at>clock_timestamp())
  ), ins as (
    insert into scheduled_jobs(org_id,job_key,kind,source_id,dispatch_id)
      select org_id,'carrier-cost:'||id,'carrier_cost_sync',source_id,id from due
    on conflict(org_id,job_key) do update set state='pending',attempts=0,next_attempt_at=now(),last_error=null,updated_at=now()
      where scheduled_jobs.state='succeeded'
    returning 1
  ) select count(*) into v_count from ins;
  return v_count;
end $$;

-- Lease the next due job of a kind. Expired leases (a crashed worker) are recorded and the
-- job is claimed again; jobs past the attempt limit are quarantined for a person.
create function claim_scheduled_job(p_org_id uuid,p_kind text) returns scheduled_jobs
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j scheduled_jobs%rowtype;
begin
  for j in select * from scheduled_jobs where org_id=p_org_id and kind=p_kind and state='running' and lease_until<=clock_timestamp() for update skip locked loop
    insert into job_runs(org_id,job_key,attempt,started_at,outcome,detail)
      values(j.org_id,j.job_key,j.attempts,j.updated_at,'lease_expired',jsonb_build_object('lease_until',j.lease_until));
    update scheduled_jobs set state=case when attempts>=8 then 'quarantined' else 'failed' end,lease_token=null,lease_until=null,
      last_error='lease expired before the run finished',updated_at=now() where org_id=j.org_id and job_key=j.job_key;
  end loop;
  select * into j from scheduled_jobs where org_id=p_org_id and kind=p_kind and state in ('pending','failed','blocked')
    and next_attempt_at<=clock_timestamp() order by next_attempt_at,job_key for update skip locked limit 1;
  if not found then return null; end if;
  update scheduled_jobs set state='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes',
    updated_at=clock_timestamp() where org_id=j.org_id and job_key=j.job_key returning * into j;
  return j;
end $$;

-- Finish a leased run. Only the current lease holder can finish it. Retries back off
-- (2, 4, 8 ... minutes, at most 6 hours); blocked waits 6 hours with its reason shown;
-- after 8 attempts the job is quarantined.
create function finish_scheduled_job(p_org_id uuid,p_job_key text,p_lease_token uuid,p_outcome text,p_detail jsonb)
returns text language plpgsql security definer set search_path=pg_catalog,public as $$
declare j scheduled_jobs%rowtype; v_state text;
begin
  if p_outcome not in ('succeeded','retry','blocked') then raise exception 'unknown job outcome'; end if;
  select * into j from scheduled_jobs where org_id=p_org_id and job_key=p_job_key for update;
  if not found or j.state<>'running' or j.lease_token is distinct from p_lease_token or j.lease_until<=clock_timestamp() then
    raise exception 'stale job lease'; end if;
  v_state:=case when p_outcome='succeeded' then 'succeeded' when j.attempts>=8 then 'quarantined' when p_outcome='blocked' then 'blocked' else 'failed' end;
  insert into job_runs(org_id,job_key,attempt,started_at,outcome,detail)
    values(j.org_id,j.job_key,j.attempts,j.updated_at,p_outcome,coalesce(p_detail,'{}'));
  update scheduled_jobs set state=v_state,lease_token=null,lease_until=null,updated_at=now(),
    last_error=case when p_outcome='succeeded' then null else left(coalesce(p_detail->>'error','unspecified'),500) end,
    next_attempt_at=case when p_outcome='blocked' then now()+interval '6 hours'
      when p_outcome='retry' then now()+least(interval '6 hours',interval '1 minute'*power(2,j.attempts)) else next_attempt_at end
    where org_id=j.org_id and job_key=j.job_key;
  return v_state;
end $$;

do $$ declare t text;r text;f regprocedure; begin
  foreach t in array array['scheduled_jobs','job_runs'] loop
    execute format('alter table %I enable row level security',t); execute format('revoke all on table %I from public',t);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on table %I from %I',t,r);
        if r='service_role' then execute format('grant select on table %I to service_role',t); end if;
      end if;
    end loop;
  end loop;
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('discover_carrier_cost_jobs','claim_scheduled_job','finish_scheduled_job') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
