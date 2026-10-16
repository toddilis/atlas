-- Manual carrier cost for a dismissed carrier cost job: a parcel that did not go through the
-- carrier adapter (for example, a hand courier) still needs its actual cost before its
-- order's first part can be drafted (PLAN D15). Owner-requested on 16 October.
--
-- This is the one way an amount typed by a person becomes carrier evidence, so it is a
-- distinct, attributable operator action, never a draft input:
--   * the business's `carriers.record_manual_cost` operator grant is required. It is NOT
--     seeded at boot; a business turns it on deliberately, and then any signed-in operator
--     of that business may use it (it is not per person). A grant set to approve_required
--     is refused, since no approval step exists for it yet. Action pause applies;
--   * only a dismissed job, unchanged since the page loaded, whose dispatch is still
--     eligible, unbilled and without an unexpired cost;
--   * the amount is a decimal string with at most two places, excluding tax, in the
--     order's own currency (never assumed); a reason is required;
--   * it is stored through record_carrier_cost under connection `manual:operator`, with
--     the operator, reason and reference as evidence, and recorded in job_runs and
--     audit_log. The draft then uses it like any stored carrier cost; its snapshot names
--     the manual connection, so the invoice calculation shows where the cost came from.
alter table job_runs drop constraint job_runs_outcome_check;
alter table job_runs add constraint job_runs_outcome_check
  check(outcome in ('succeeded','retry','blocked','lease_expired','not_needed','operator_retry','operator_dismiss','operator_cost'));

create function record_manual_carrier_cost(p_org_id uuid,p_job_key text,p_expected_updated_at timestamptz,
  p_actor_id uuid,p_actor_email text,p_reason text,p_cost text,p_reference text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare j scheduled_jobs%rowtype; d dispatches%rowtype; v_currency text; v_minor bigint; v_id uuid; v_at timestamptz:=clock_timestamp();
begin
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'cost reason required'; end if;
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  if coalesce(trim(p_cost),'') !~ '^[0-9]{1,9}(\.[0-9]{1,2})?$' then raise exception 'carrier cost must be an amount with at most two decimals'; end if;
  v_minor:=(trim(p_cost)::numeric*100)::bigint;
  perform assert_action_authority(p_org_id,'operator','carriers.record_manual_cost');
  if exists(select 1 from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='carriers.record_manual_cost'
    and risk='approve_required') then raise exception 'manual carrier cost approval is not built; its grant must not require approval'; end if;
  select * into j from scheduled_jobs where org_id=p_org_id and job_key=p_job_key for update;
  if not found then raise exception 'job not found'; end if;
  if j.updated_at is distinct from p_expected_updated_at then raise exception 'job changed since it was loaded'; end if;
  if j.kind<>'carrier_cost_sync' or j.state<>'dismissed' then raise exception 'only dismissed jobs can take a manual carrier cost'; end if;
  if not carrier_cost_job_needed(j.org_id,j.source_id,j.dispatch_id) then raise exception 'job no longer needed'; end if;
  select * into d from dispatches where org_id=j.org_id and source_id=j.source_id and id=j.dispatch_id;
  select o.currency into v_currency from shopify_fulfillments f join shopify_orders o on o.id=f.shopify_order_id
    where f.org_id=d.org_id and f.dispatch_id=d.id;
  if v_currency is null then raise exception 'order currency unknown'; end if;
  -- An actual cost, not a quote: it stays usable for a year of drafting.
  v_id:=record_carrier_cost(d.org_id,d.source_id,d.id,'manual:operator','manual:'||gen_random_uuid(),v_currency,v_minor,
    v_at,v_at+interval '365 days',jsonb_build_object('provider','manual','job_key',j.job_key,
      'entered_by',jsonb_build_object('actor_id',p_actor_id,'email',p_actor_email),
      'reason',trim(p_reason),'reference',nullif(trim(coalesce(p_reference,'')),''),'amount',trim(p_cost),'tax_basis','exclusive'));
  insert into job_runs(org_id,job_key,attempt,started_at,outcome,detail)
    values(j.org_id,j.job_key,j.attempts,v_at,'operator_cost',jsonb_build_object(
      'actor_id',p_actor_id,'actor_email',p_actor_email,'reason',trim(p_reason),'reference',nullif(trim(coalesce(p_reference,'')),''),
      'cost_minor',v_minor::text,'currency',v_currency,'evidence_id',v_id,'previous_state',j.state));
  update scheduled_jobs set state='succeeded',last_error=null,updated_at=clock_timestamp() where org_id=j.org_id and job_key=j.job_key;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(j.org_id,'operator','carriers.record_manual_cost','carriers.record_manual_cost','dispatch',d.id,'notify','success',jsonb_build_object(
      'job_key',j.job_key,'actor_id',p_actor_id,'actor_email',p_actor_email,'reason',trim(p_reason),
      'reference',nullif(trim(coalesce(p_reference,'')),''),'cost_minor',v_minor::text,'currency',v_currency,'evidence_id',v_id));
  return v_id;
end $$;

do $$ declare r text; f regprocedure:='record_manual_carrier_cost(uuid,text,timestamptz,uuid,text,text,text,text)'::regprocedure; begin
  execute format('revoke all on function %s from public',f);
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
      if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
    end if;
  end loop;
end $$;
