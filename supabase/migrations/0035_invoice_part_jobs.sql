-- Step 4c: Atlas drafts each wholesale shipment's invoice part itself. The legacy path
-- already refuses every dispatch-backed fulfillment ("BILL-01 invoice creation is not
-- enabled"), so nothing was being drafted; this turns BILL drafting on as a JOBS-01 job
-- kind. Discovery finds eligible, wholesale-routed Shopify dispatches without a part; the
-- worker builds the pricing input from stored records and drafts through
-- draft_dispatch_invoice (0028), which re-checks everything. A job that cannot proceed is
-- blocked with its reason in the jobs console, and is woken as soon as what it waits for
-- arrives: the shipment's carrier cost, an earlier shipment's part, or an activated
-- pricing version.

alter table scheduled_jobs drop constraint scheduled_jobs_kind_check;
alter table scheduled_jobs add constraint scheduled_jobs_kind_check check(kind in ('carrier_cost_sync','invoice_part_draft'));

-- Only wholesale-routed shipments are invoiced, so only they need a part, or a carrier cost.
create function dispatch_routed_wholesale(p_org_id uuid,p_dispatch_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from shopify_fulfillments f join fulfillment_events e on e.org_id=f.org_id and e.shopify_fulfillment_id=f.id
    where f.org_id=p_org_id and f.dispatch_id=p_dispatch_id and e.route='wholesale')
$$;

create or replace function carrier_cost_job_needed(p_org_id uuid,p_source_id uuid,p_dispatch_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from dispatches d where d.org_id=p_org_id and d.source_id=p_source_id and d.id=p_dispatch_id and d.state='eligible'
    and dispatch_routed_wholesale(d.org_id,d.id)
    and not exists(select 1 from invoice_calculation_snapshots x join dispatches o on o.id=x.dispatch_id
      where x.org_id=d.org_id and x.source_id=d.source_id and o.order_key=d.order_key)
    and not exists(select 1 from carrier_cost_evidence e where e.org_id=d.org_id and e.dispatch_id=d.id and e.expires_at>clock_timestamp()))
$$;

create function invoice_part_job_needed(p_org_id uuid,p_source_id uuid,p_dispatch_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from dispatches d
    join dispatch_sources s on s.org_id=d.org_id and s.id=d.source_id and s.provider='shopify' and s.enabled
    where d.org_id=p_org_id and d.source_id=p_source_id and d.id=p_dispatch_id and d.state='eligible'
      and dispatch_routed_wholesale(d.org_id,d.id)
      and not exists(select 1 from dispatch_invoice_parts p where p.org_id=d.org_id and p.dispatch_id=d.id))
$$;

-- Whether a job's work is still needed, for every kind: claims, retry and discovery use it.
create function scheduled_job_needed(j scheduled_jobs) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select case j.kind when 'carrier_cost_sync' then carrier_cost_job_needed(j.org_id,j.source_id,j.dispatch_id)
    when 'invoice_part_draft' then invoice_part_job_needed(j.org_id,j.source_id,j.dispatch_id) else false end
$$;

create function discover_invoice_part_jobs(p_org_id uuid) returns integer
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_count integer; j scheduled_jobs%rowtype;
begin
  for j in select * from scheduled_jobs where org_id=p_org_id and kind='invoice_part_draft' and state in ('pending','failed','blocked','quarantined')
    and not invoice_part_job_needed(org_id,source_id,dispatch_id) for update skip locked loop
    perform close_unneeded_job(j);
  end loop;
  with ins as (
    insert into scheduled_jobs(org_id,job_key,kind,source_id,dispatch_id)
      select d.org_id,'invoice-part:'||d.id,'invoice_part_draft',d.source_id,d.id from dispatches d
      where d.org_id=p_org_id and d.state='eligible' and invoice_part_job_needed(d.org_id,d.source_id,d.id)
    on conflict(org_id,job_key) do update set state='pending',attempts=0,next_attempt_at=now(),last_error=null,updated_at=now()
      where scheduled_jobs.state='succeeded'
    returning 1
  ) select count(*) into v_count from ins;
  return v_count;
end $$;

-- Claims as in 0029, with the need check for every kind.
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
  update scheduled_jobs set state='running',attempts=attempts+1,lease_token=gen_random_uuid(),lease_until=clock_timestamp()+interval '5 minutes',
    updated_at=clock_timestamp() where org_id=j.org_id and job_key=j.job_key returning * into j;
  return j;
end $$;

-- Operator retry as in 0031, with the need check for every kind.
create or replace function retry_scheduled_job(p_org_id uuid,p_job_key text,p_expected_updated_at timestamptz,
  p_actor_id uuid,p_actor_email text,p_reason text) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j scheduled_jobs%rowtype;
begin
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'retry reason required'; end if;
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','jobs.retry');
  select * into j from scheduled_jobs where org_id=p_org_id and job_key=p_job_key for update;
  if not found then raise exception 'job not found'; end if;
  if j.updated_at is distinct from p_expected_updated_at then raise exception 'job changed since it was loaded'; end if;
  if j.state not in ('blocked','quarantined','dismissed') then raise exception 'only blocked, quarantined or dismissed jobs can be retried'; end if;
  if not scheduled_job_needed(j) then raise exception 'job no longer needed'; end if;
  insert into job_runs(org_id,job_key,attempt,started_at,outcome,detail)
    values(j.org_id,j.job_key,j.attempts,clock_timestamp(),'operator_retry',jsonb_build_object(
      'actor_id',p_actor_id,'actor_email',p_actor_email,'reason',trim(p_reason),
      'previous_state',j.state,'previous_error',j.last_error));
  update scheduled_jobs set state='pending',attempts=0,next_attempt_at=now(),last_error=null,updated_at=clock_timestamp()
    where org_id=j.org_id and job_key=j.job_key;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,risk,outcome,detail)
    values(j.org_id,'operator','jobs.retry','jobs.retry','scheduled_job','notify','success',jsonb_build_object(
      'job_key',j.job_key,'actor_id',p_actor_id,'actor_email',p_actor_email,'reason',trim(p_reason),
      'previous_state',j.state,'previous_attempts',j.attempts,'previous_error',j.last_error));
  return 'pending';
end $$;

-- Wake waiting invoice part jobs when what they wait for arrives, instead of at their next
-- backoff: a carrier cost for the shipment, a part for an earlier shipment of the order, or
-- a newly activated pricing version. Only the due time moves; attempts are unchanged.
create function wake_invoice_part_jobs() returns trigger
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if TG_TABLE_NAME='carrier_cost_evidence' then
    update scheduled_jobs set next_attempt_at=now(),updated_at=clock_timestamp()
      where org_id=new.org_id and kind='invoice_part_draft' and dispatch_id=new.dispatch_id and state in ('blocked','failed') and next_attempt_at>now();
  elsif TG_TABLE_NAME='dispatch_invoice_parts' then
    update scheduled_jobs j set next_attempt_at=now(),updated_at=clock_timestamp()
      from dispatches mine, dispatches d
      where mine.org_id=new.org_id and mine.id=new.dispatch_id
        and d.org_id=mine.org_id and d.source_id=mine.source_id and d.order_key=mine.order_key and d.id<>mine.id
        and j.org_id=d.org_id and j.kind='invoice_part_draft' and j.dispatch_id=d.id and j.state in ('blocked','failed') and j.next_attempt_at>now();
  else
    update scheduled_jobs set next_attempt_at=now(),updated_at=clock_timestamp()
      where org_id=new.org_id and kind='invoice_part_draft' and state in ('blocked','failed') and next_attempt_at>now();
  end if;
  return null;
end $$;
create trigger carrier_cost_wakes_invoice_parts after insert on carrier_cost_evidence for each row execute function wake_invoice_part_jobs();
create trigger invoice_part_wakes_later_shipments after insert on dispatch_invoice_parts for each row execute function wake_invoice_part_jobs();
create trigger pricing_activation_wakes_invoice_parts after insert on pricing_activations for each row execute function wake_invoice_part_jobs();

do $$ declare r text; f regprocedure; begin
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('dispatch_routed_wholesale','invoice_part_job_needed','scheduled_job_needed','discover_invoice_part_jobs','wake_invoice_part_jobs') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        -- Discovery is the worker's; the rest are internal.
        if r='service_role' and f::text like 'discover_invoice_part_jobs%' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
