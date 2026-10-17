-- PRICING-01 console journey: the operator entry points for saving and activating a
-- pricing version. The console verifies the signed-in operator (session, allowlist, same
-- origin); the database enforces the rest: action pause and the business's `pricing.save`
-- / `pricing.activate` operator grants, that every product and retailer the version names
-- belongs to this business, a reason, the expected revision (0023), and an audit row with
-- who acted, why, and the version it replaced. No role but service_role may call them.

-- Every product and retailer a configuration names must be this business's own record,
-- so a typo or another business's id is refused rather than priced as "not found" later.
create function assert_pricing_references(p_org_id uuid,p_config jsonb) returns void
language plpgsql stable security definer set search_path=pg_catalog,public as $$
declare v_missing text;
begin
  select string_agg(distinct x,', ') into v_missing from (
    select jsonb_path_query(p_config,'$.books[*].entries[*].productId')#>>'{}' x
    union all select jsonb_path_query(p_config,'$.negotiated[*].productId')#>>'{}'
    union all select jsonb_path_query(p_config,'$.tiers[*].productId')#>>'{}'
    union all select jsonb_path_query(p_config,'$.discounts[*].productId')#>>'{}') p
  where not exists(select 1 from products where org_id=p_org_id and id::text=p.x);
  if v_missing is not null then raise exception 'pricing names products this business does not have: %',v_missing; end if;
  select string_agg(distinct x,', ') into v_missing from (
    select jsonb_path_query(p_config,'$.bindings[*].accountId')#>>'{}' x
    union all select jsonb_path_query(p_config,'$.negotiated[*].accountId ? (@ != null)')#>>'{}'
    union all select jsonb_path_query(p_config,'$.tiers[*].accountId ? (@ != null)')#>>'{}'
    union all select jsonb_path_query(p_config,'$.discounts[*].accountId ? (@ != null)')#>>'{}'
    union all select jsonb_path_query(p_config,'$.shipping.rules[*].accountId ? (@ != null)')#>>'{}') a
  where not exists(select 1 from accounts where org_id=p_org_id and id::text=a.x);
  if v_missing is not null then raise exception 'pricing names retailers this business does not have: %',v_missing; end if;
end $$;

create function operator_save_pricing_version(p_org_id uuid,p_expected_revision integer,p_config jsonb,
  p_actor_id uuid,p_actor_email text,p_reason text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid; v_new boolean;
begin
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'pricing reason required'; end if;
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','pricing.save');
  perform assert_pricing_references(p_org_id,p_config);
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':pricing',0));
  -- An exact retry returns the saved version unchanged and is not audited twice. Otherwise a
  -- page loaded before someone else's save is stale, even when both chose the same next
  -- identifier, so the operator is told to compare rather than to rename.
  select id into v_id from pricing_versions where org_id=p_org_id and version_key=p_config->>'version'
    and config=p_config and actor=trim(p_actor_email) and reason=trim(p_reason);
  if found then return v_id; end if;
  if p_expected_revision is distinct from (select coalesce(max(revision),0) from pricing_versions where org_id=p_org_id) then
    raise exception 'stale pricing revision'; end if;
  v_new:=not exists(select 1 from pricing_versions where org_id=p_org_id and version_key=p_config->>'version');
  v_id:=save_pricing_version(p_org_id,p_expected_revision,p_config,trim(p_actor_email),trim(p_reason));
  if v_new then
    insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
      select p_org_id,'operator','pricing.save','pricing.save','pricing_version',v.id,'notify','success',jsonb_build_object(
        'actor_id',p_actor_id,'actor_email',trim(p_actor_email),'reason',trim(p_reason),'version_key',v.version_key,'revision',v.revision)
      from pricing_versions v where v.id=v_id;
  end if;
  return v_id;
end $$;

create function operator_activate_pricing_version(p_org_id uuid,p_version_id uuid,p_expected_revision integer,
  p_actor_id uuid,p_actor_email text,p_reason text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_id uuid; v_new boolean; v_previous uuid;
begin
  if length(trim(coalesce(p_reason,'')))<3 then raise exception 'pricing reason required'; end if;
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','pricing.activate');
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':pricing',0));
  perform assert_pricing_references(p_org_id,(select config from pricing_versions where org_id=p_org_id and id=p_version_id));
  v_new:=not exists(select 1 from pricing_activations where org_id=p_org_id and version_id=p_version_id);
  select a.version_id into v_previous from pricing_activations a join pricing_versions v on v.id=a.version_id
    where a.org_id=p_org_id order by (v.config->>'effectiveFrom')::timestamptz desc limit 1;
  v_id:=activate_pricing_version(p_org_id,p_version_id,p_expected_revision,trim(p_actor_email),trim(p_reason));
  if v_new then
    insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
      select p_org_id,'operator','pricing.activate','pricing.activate','pricing_version',v.id,'notify','success',jsonb_build_object(
        'actor_id',p_actor_id,'actor_email',trim(p_actor_email),'reason',trim(p_reason),'version_key',v.version_key,'revision',v.revision,
        'effective_from',v.config->>'effectiveFrom','previous_version_id',v_previous)
      from pricing_versions v where v.id=p_version_id;
  end if;
  return v_id;
end $$;

do $$ declare r text; f regprocedure; begin
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('assert_pricing_references','operator_save_pricing_version','operator_activate_pricing_version') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
