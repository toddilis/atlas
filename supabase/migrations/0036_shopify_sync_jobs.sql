-- JOBS-01 scheduled ingestion: the Shopify sync runs as a recurring job instead of waiting
-- for someone to call /admin/shopify/sync. Discovery keeps one job per enabled Shopify
-- source and re-arms it once the source's own cadence has elapsed since the last
-- successful sync; failures back off and stay visible with their reason like every other
-- job, and the operator pause stops claims. A sync job belongs to a connection, not a
-- shipment, so scheduled_jobs now allows a null dispatch for exactly this kind.

-- How often a source's canonical data is pulled. Cadence is business configuration, not
-- code: each connection carries its own.
alter table dispatch_sources add column sync_every_minutes integer not null default 15
  check (sync_every_minutes between 1 and 1440);

alter table scheduled_jobs drop constraint scheduled_jobs_kind_check;
alter table scheduled_jobs add constraint scheduled_jobs_kind_check
  check(kind in ('carrier_cost_sync','invoice_part_draft','shopify_sync'));
alter table scheduled_jobs alter column dispatch_id drop not null;
-- Work jobs name their shipment; a sync job names only its connection. (With a null
-- dispatch the composite dispatch FK no longer applies, so the source is referenced
-- directly below.)
alter table scheduled_jobs add constraint scheduled_jobs_dispatch_scope
  check((dispatch_id is null) = (kind = 'shopify_sync'));
alter table scheduled_jobs add constraint scheduled_jobs_source_fk
  foreign key (org_id,source_id) references dispatch_sources(org_id,id);

create function shopify_sync_job_needed(p_org_id uuid,p_source_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from dispatch_sources s
    where s.org_id=p_org_id and s.id=p_source_id and s.provider='shopify' and s.enabled)
$$;

create or replace function scheduled_job_needed(j scheduled_jobs) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select case j.kind when 'carrier_cost_sync' then carrier_cost_job_needed(j.org_id,j.source_id,j.dispatch_id)
    when 'invoice_part_draft' then invoice_part_job_needed(j.org_id,j.source_id,j.dispatch_id)
    when 'shopify_sync' then shopify_sync_job_needed(j.org_id,j.source_id) else false end
$$;

-- One job per enabled Shopify source. A succeeded job is re-armed only once the source's
-- cadence has elapsed since it finished; a waiting or stopped job of a disabled source is
-- closed. Failed and blocked jobs keep their own backoff and operator path.
create function discover_shopify_sync_jobs(p_org_id uuid) returns integer
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_rearmed integer; v_inserted integer; j scheduled_jobs%rowtype;
begin
  for j in select * from scheduled_jobs where org_id=p_org_id and kind='shopify_sync' and state in ('pending','failed','blocked','quarantined')
    and not shopify_sync_job_needed(org_id,source_id) for update skip locked loop
    perform close_unneeded_job(j);
  end loop;
  update scheduled_jobs t set state='pending',attempts=0,next_attempt_at=now(),last_error=null,updated_at=now()
    from dispatch_sources s
    where t.org_id=p_org_id and t.kind='shopify_sync' and t.state='succeeded'
      and s.org_id=t.org_id and s.id=t.source_id and s.provider='shopify' and s.enabled
      and t.updated_at <= now() - make_interval(mins => s.sync_every_minutes);
  get diagnostics v_rearmed = row_count;
  with ins as (
    insert into scheduled_jobs(org_id,job_key,kind,source_id,dispatch_id)
      select s.org_id,'shopify-sync:'||s.id,'shopify_sync',s.id,null from dispatch_sources s
      where s.org_id=p_org_id and s.provider='shopify' and s.enabled
    on conflict(org_id,job_key) do nothing
    returning 1
  ) select count(*) into v_inserted from ins;
  return v_rearmed + v_inserted;
end $$;

-- Claims as in 0035; a full canonical sync can outlast a work job, so its lease is longer.
create or replace function claim_scheduled_job(p_org_id uuid,p_kind text) returns scheduled_jobs
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j scheduled_jobs%rowtype;
begin
  for j in select * from scheduled_jobs where org_id=p_org_id and kind=p_kind and state='running' and lease_until<=clock_timestamp() for update skip locked loop
    insert into job_runs(org_id,job_key,attempt,started_at,outcome,detail)
      values(j.org_id,j.job_key,j.attempts,j.updated_at,'lease_expired',jsonb_build_object('lease_until',j.lease_until));
    update scheduled_jobs set state=case when attempts>=8 then 'quarantined' else 'failed' end,lease_token=null,lease_until=null,
      last_error='lease expired before the run finished',updated_at=now() where org_id=j.org_id and job_key=j.job_key;
  end loop;
  if coalesce((select paused from action_controls where org_id=p_org_id),false) then return null; end if;
  loop
    select * into j from scheduled_jobs where org_id=p_org_id and kind=p_kind and state in ('pending','failed','blocked')
      and next_attempt_at<=clock_timestamp() order by next_attempt_at,job_key for update skip locked limit 1;
    if not found then return null; end if;
    exit when scheduled_job_needed(j);
    perform close_unneeded_job(j);
  end loop;
  update scheduled_jobs set state='running',attempts=attempts+1,lease_token=gen_random_uuid(),
    lease_until=clock_timestamp()+case when j.kind='shopify_sync' then interval '30 minutes' else interval '5 minutes' end,
    updated_at=clock_timestamp() where org_id=j.org_id and job_key=j.job_key returning * into j;
  return j;
end $$;

do $$ declare r text; f regprocedure; begin
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('shopify_sync_job_needed','discover_shopify_sync_jobs') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        -- Discovery is the worker's; the need check is internal.
        if r='service_role' and f::text like 'discover_shopify_sync_jobs%' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
