-- CONFIG-01b: the business's Shopify connection in the console. Connecting a shop,
-- setting its sync cadence and enabling/disabling it previously took SQL;
-- bind_shopify_dispatch_source (0021) stays the canonical owner of the domain rule,
-- the one-connection-per-business rule and retry stability, and this entry point adds
-- the operator rules on top: identity, action pause, the connections.save grant
-- (seeded notify-tier at boot, like catalogue setup), cadence bounds, stale-edit
-- detection, the connection key fixed as the source identity, and an audit row per
-- change. The scheduled sync (0036) reads enabled/sync_every_minutes directly, so a
-- console change feeds the job machinery with no further wiring. Service-role only.

-- Stale-edit detection, like products (0040).
alter table dispatch_sources add column updated_at timestamptz not null default now();

create function operator_save_shopify_connection(p_org_id uuid,p_source_id uuid,p_connection_key text,
  p_enabled boolean,p_sync_every_minutes integer,p_expected_updated_at timestamptz,p_actor_id uuid,p_actor_email text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_row dispatch_sources%rowtype; v_id uuid; v_key text:=trim(coalesce(p_connection_key,''));
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','connections.save');
  if p_enabled is null then raise exception 'connection fields required'; end if;
  if p_sync_every_minutes is null or p_sync_every_minutes<1 or p_sync_every_minutes>1440 then
    raise exception 'sync cadence minutes out of range'; end if;
  -- The same lock bind_shopify_dispatch_source takes, so the existence check and the
  -- bind cannot race another connect.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':shopify-binding',0));
  if p_source_id is null then
    select * into v_row from dispatch_sources where org_id=p_org_id and provider='shopify';
    if found then
      -- An exact retry returns the connection unchanged and is not audited twice.
      if v_row.connection_key=v_key and v_row.enabled=p_enabled and v_row.sync_every_minutes=p_sync_every_minutes then return v_row.id; end if;
      raise exception 'this business already has its Shopify connection';
    end if;
    v_id:=bind_shopify_dispatch_source(p_org_id,v_key);
    update dispatch_sources set enabled=p_enabled,sync_every_minutes=p_sync_every_minutes,updated_at=clock_timestamp() where id=v_id;
  else
    select * into v_row from dispatch_sources where org_id=p_org_id and id=p_source_id and provider='shopify';
    if not found then raise exception 'connection not found'; end if;
    if p_expected_updated_at is null or v_row.updated_at is distinct from p_expected_updated_at then
      raise exception 'connection changed since it was loaded'; end if;
    -- The shop domain is the source identity every dispatch hangs off: it never
    -- changes. A different shop is a different connection, not a rename.
    if v_key<>'' and v_key<>v_row.connection_key then raise exception 'the connection''s shop domain is fixed'; end if;
    update dispatch_sources set enabled=p_enabled,sync_every_minutes=p_sync_every_minutes,updated_at=clock_timestamp() where id=v_row.id;
    v_id:=v_row.id;
  end if;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','connections.save','connections.save','dispatch_source',v_id,'notify','success',jsonb_build_object(
      'actor_id',p_actor_id,'actor_email',trim(p_actor_email),'connection_key',coalesce(nullif(v_key,''),v_row.connection_key),
      'enabled',p_enabled,'sync_every_minutes',p_sync_every_minutes,'created',p_source_id is null));
  return v_id;
end $$;

do $$ declare r text; f regprocedure; begin
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('operator_save_shopify_connection') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
