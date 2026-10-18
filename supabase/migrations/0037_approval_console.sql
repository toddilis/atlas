-- UI-01: operators decide pending bound approvals in the console with their own
-- authenticated identity, and the worker executes what they approve as a JOBS-01 job
-- (kind approved_action_execute). decide_bound_approval (0022) keeps owning the decision
-- itself — pending/expiry/revocation, the agent's entitlement and policy-snapshot
-- equality — and executeApproved keeps owning execution. This adds the operator seam
-- (identity, grant, reason, audit) and the durable execution loop with the jobs
-- machinery's leases, backoff, quarantine and console visibility.

-- The executor job names the bound action it runs; it has no source or shipment.
alter table scheduled_jobs alter column source_id drop not null;
alter table scheduled_jobs add column action_id uuid;
alter table scheduled_jobs add constraint scheduled_jobs_action_fk
  foreign key (org_id,action_id) references approved_actions(org_id,id);
alter table scheduled_jobs drop constraint scheduled_jobs_kind_check;
alter table scheduled_jobs add constraint scheduled_jobs_kind_check
  check(kind in ('carrier_cost_sync','invoice_part_draft','shopify_sync','approved_action_execute'));
-- Work jobs name their shipment, source-scoped jobs their connection, and the executor
-- its action — each exactly once. An unknown kind is the kind check's to reject, so this
-- shape constraint (kept under 0036's name) says nothing about it.
alter table scheduled_jobs drop constraint scheduled_jobs_dispatch_scope;
alter table scheduled_jobs add constraint scheduled_jobs_dispatch_scope check(
  case kind
    when 'carrier_cost_sync' then dispatch_id is not null and source_id is not null and action_id is null
    when 'invoice_part_draft' then dispatch_id is not null and source_id is not null and action_id is null
    when 'shopify_sync' then dispatch_id is null and source_id is not null and action_id is null
    when 'approved_action_execute' then dispatch_id is null and source_id is null and action_id is not null
    else true end);

-- The console's decision seam. The operator is authenticated by the console; this
-- enforces pause and the operator's own grant, requires a reason, hands the decision to
-- decide_bound_approval (which re-checks the approval and the AGENT's authority), and
-- records who decided in the audit trail. Approving is a decision, not an execution:
-- the grant is notify-tier, and a grant set to approve_required would make deciding
-- approvals itself need an approval, so it is refused outright (0032's precedent).
create function operator_decide_approval(p_org_id uuid,p_approval_id uuid,
  p_actor_id uuid,p_actor_email text,p_disposition text,p_reason text) returns text
language plpgsql security definer set search_path=pg_catalog,public as $$
begin
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'decision reason required'; end if;
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  if p_disposition not in ('approved','rejected') then raise exception 'invalid approval decision'; end if;
  perform assert_action_authority(p_org_id,'operator','approvals.decide');
  if exists(select 1 from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='approvals.decide'
    and enabled and risk='approve_required') then
    raise exception 'deciding approvals cannot itself require an approval; its grant must not require approval'; end if;
  perform decide_bound_approval(p_org_id,p_approval_id,p_disposition,trim(p_actor_email),trim(p_reason));
  insert into audit_log(org_id,agent_name,action,tool_name,approval_id,subject_type,risk,outcome,detail)
    values(p_org_id,'operator','approvals.decide','approvals.decide',p_approval_id,'approval','notify','success',
      jsonb_build_object('approval_id',p_approval_id,'actor_id',p_actor_id,'actor_email',trim(p_actor_email),
        'disposition',p_disposition,'reason',trim(p_reason)));
  return p_disposition;
end $$;

-- An approved, unexpired, unrevoked action that is AUTHORISED still needs executing.
-- FAILED, UNRESOLVED and RECONCILIATION_REQUIRED actions are never re-run on their own:
-- they stay visible on the approvals page for a person (spec: bounded retries only after
-- no-effect evidence, and never an automatic retry of an uncertain result).
create function approved_action_job_needed(p_org_id uuid,p_action_id uuid) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select exists(select 1 from approved_actions v join approvals a on a.org_id=v.org_id and a.id=v.approval_id
    where v.org_id=p_org_id and v.id=p_action_id and v.state='AUTHORISED' and v.revoked_at is null
      and a.state='approved' and (a.expires_at is null or a.expires_at>clock_timestamp()))
$$;

create or replace function scheduled_job_needed(j scheduled_jobs) returns boolean
language sql stable security definer set search_path=pg_catalog,public as $$
  select case j.kind when 'carrier_cost_sync' then carrier_cost_job_needed(j.org_id,j.source_id,j.dispatch_id)
    when 'invoice_part_draft' then invoice_part_job_needed(j.org_id,j.source_id,j.dispatch_id)
    when 'shopify_sync' then shopify_sync_job_needed(j.org_id,j.source_id)
    when 'approved_action_execute' then approved_action_job_needed(j.org_id,j.action_id) else false end
$$;

create function discover_approved_action_jobs(p_org_id uuid) returns integer
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_count integer; j scheduled_jobs%rowtype;
begin
  for j in select * from scheduled_jobs where org_id=p_org_id and kind='approved_action_execute' and state in ('pending','failed','blocked','quarantined')
    and not approved_action_job_needed(org_id,action_id) for update skip locked loop
    perform close_unneeded_job(j);
  end loop;
  with ins as (
    insert into scheduled_jobs(org_id,job_key,kind,action_id)
      select v.org_id,'approved-action:'||v.id,'approved_action_execute',v.id
      from approved_actions v join approvals a on a.org_id=v.org_id and a.id=v.approval_id
      where v.org_id=p_org_id and v.state='AUTHORISED' and v.revoked_at is null
        and a.state='approved' and (a.expires_at is null or a.expires_at>clock_timestamp())
    on conflict(org_id,job_key) do update set state='pending',attempts=0,next_attempt_at=now(),last_error=null,updated_at=now()
      where scheduled_jobs.state='succeeded'
    returning 1
  ) select count(*) into v_count from ins;
  return v_count;
end $$;

do $$ declare r text; f regprocedure; begin
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('operator_decide_approval','approved_action_job_needed','discover_approved_action_jobs') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        -- The console decides and the worker discovers; the need check is internal.
        if r='service_role' and f::text not like 'approved_action_job_needed%' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
