-- Operator retry for background jobs a person had to look at (blocked or quarantined).
-- The console calls this after verifying the operator; the database enforces the rest:
-- action pause and the operator's `jobs.retry` tool grant, that the job is still the one
-- the operator saw, and that the dispatch still needs the work. Each retry is recorded in
-- job_runs and audit_log with who asked and why.
alter table job_runs drop constraint job_runs_outcome_check;
alter table job_runs add constraint job_runs_outcome_check
  check(outcome in ('succeeded','retry','blocked','lease_expired','operator_retry'));

create function retry_scheduled_job(p_org_id uuid,p_job_key text,p_expected_updated_at timestamptz,
  p_actor_id uuid,p_actor_email text,p_reason text) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j scheduled_jobs%rowtype; d dispatches%rowtype;
begin
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'retry reason required'; end if;
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','jobs.retry');
  select * into j from scheduled_jobs where org_id=p_org_id and job_key=p_job_key for update;
  if not found then raise exception 'job not found'; end if;
  if j.updated_at is distinct from p_expected_updated_at then raise exception 'job changed since it was loaded'; end if;
  if j.state not in ('blocked','quarantined') then raise exception 'only blocked or quarantined jobs can be retried'; end if;
  -- Current preconditions, as discovery states them: the dispatch is still eligible, its
  -- order is still unbilled and it has no unexpired carrier cost.
  if j.kind='carrier_cost_sync' then
    select * into d from dispatches where org_id=j.org_id and source_id=j.source_id and id=j.dispatch_id;
    if not found or d.state<>'eligible'
      or exists(select 1 from invoice_calculation_snapshots x join dispatches o on o.id=x.dispatch_id
        where x.org_id=d.org_id and x.source_id=d.source_id and o.order_key=d.order_key)
      or exists(select 1 from carrier_cost_evidence e where e.org_id=d.org_id and e.dispatch_id=d.id and e.expires_at>clock_timestamp())
    then raise exception 'job no longer needed'; end if;
  end if;
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

do $$ declare r text; f regprocedure:='retry_scheduled_job(uuid,text,timestamptz,uuid,text,text)'::regprocedure; begin
  execute format('revoke all on function %s from public',f);
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
      if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
    end if;
  end loop;
end $$;
