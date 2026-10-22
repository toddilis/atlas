-- UI-01b: the operator's emergency stop in the console. Pausing and resuming business
-- actions previously required the legacy bearer-token API route or SQL; every console
-- page already reads the pause state, and now an authenticated operator sets it. The
-- canonical transition stays set_action_pause (0022) — durable action_controls upsert,
-- idempotent, actor and reason required. This entry point adds the operator rules on
-- top: identity, a reason, the business's actions.pause grant (seeded notify-tier at
-- boot: a business should not have to switch on its own emergency stop), and an audit
-- row naming who and why. No role but service_role may call it.
--
-- Deliberately NOT assert_action_authority: that helper refuses while paused, which
-- would make resuming impossible. The grant and agent checks run; the pause gate does
-- not — the pause control itself stands outside the pause, like revocation.

create function operator_set_action_pause(p_org_id uuid,p_paused boolean,p_actor_id uuid,p_actor_email text,p_reason text) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_risk text;
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'pause reason required'; end if;
  if p_paused is null then raise exception 'pause state required'; end if;
  if exists(select 1 from agents where org_id=p_org_id and name='operator' and not enabled) then raise exception 'agent disabled'; end if;
  select risk into v_risk from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='actions.pause' and enabled;
  if v_risk is null then raise exception 'tool entitlement missing or revoked'; end if;
  if v_risk='approve_required' then raise exception 'the emergency stop cannot wait for an approval; its grant must not require approval'; end if;
  perform set_action_pause(p_org_id,p_paused,trim(p_actor_email),trim(p_reason));
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator',case when p_paused then 'actions.pause' else 'actions.resume' end,'actions.pause','action_controls',p_org_id,'notify','success',
      jsonb_build_object('actor_id',p_actor_id,'actor_email',trim(p_actor_email),'paused',p_paused,'reason',trim(p_reason)));
end $$;

do $$ declare r text; f regprocedure; begin
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('operator_set_action_pause') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
