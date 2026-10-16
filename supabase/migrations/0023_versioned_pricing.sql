-- PRICING-01. Service-only storage; operator entry points must use the shared
-- authenticated tool/policy boundary. No client-selected org authority or grants.
create table pricing_versions (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references orgs(id),
  version_key text not null, revision integer not null check (revision > 0),
  config jsonb not null check (jsonb_typeof(config) = 'object'),
  actor text not null check (length(actor) > 0), reason text not null check (length(reason) > 0),
  created_at timestamptz not null default now(),
  unique (org_id, id), unique (org_id, version_key), unique (org_id, revision),
  check (config->>'businessId' = org_id::text), check (config->>'version' = version_key),
  check (config->>'schemaVersion' = '1')
);
create table pricing_activations (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references orgs(id),
  version_id uuid not null, actor text not null check (length(actor) > 0),
  reason text not null check (length(reason) > 0), created_at timestamptz not null default now(),
  foreign key (org_id, version_id) references pricing_versions(org_id,id), unique (version_id)
);
create trigger pricing_versions_immutable before update or delete on pricing_versions
  for each row execute function reject_dispatch_history_mutation();
create trigger pricing_activations_immutable before update or delete on pricing_activations
  for each row execute function reject_dispatch_history_mutation();

create function save_pricing_version(p_org_id uuid, p_expected_revision integer, p_config jsonb, p_actor text, p_reason text)
returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_revision integer; v_existing pricing_versions%rowtype; v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':pricing', 0));
  if p_expected_revision is null or p_expected_revision < 0 or nullif(btrim(p_actor),'') is null or nullif(btrim(p_reason),'') is null then
    raise exception 'pricing actor, reason and expected revision required'; end if;
  if jsonb_typeof(p_config) is distinct from 'object' or p_config->>'businessId' is distinct from p_org_id::text
    or p_config->>'schemaVersion' is distinct from '1' or nullif(p_config->>'version','') is null then
    raise exception 'invalid business-scoped pricing configuration'; end if;
  select * into v_existing from pricing_versions where org_id=p_org_id and version_key=p_config->>'version';
  if found then
    if v_existing.config <> p_config or v_existing.actor <> p_actor or v_existing.reason <> p_reason then
      raise exception 'pricing retry conflicts with stored version'; end if;
    return v_existing.id;
  end if;
  select coalesce(max(revision),0) into v_revision from pricing_versions where org_id=p_org_id;
  if v_revision <> p_expected_revision then raise exception 'stale pricing revision'; end if;
  insert into pricing_versions(org_id,version_key,revision,config,actor,reason)
    values(p_org_id,p_config->>'version',v_revision+1,p_config,p_actor,p_reason) returning id into v_id;
  return v_id;
end $$;

create function activate_pricing_version(p_org_id uuid,p_version_id uuid,p_expected_revision integer,p_actor text,p_reason text)
returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_config jsonb; v_revision integer; v_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':pricing',0));
  if nullif(btrim(p_actor),'') is null or nullif(btrim(p_reason),'') is null then raise exception 'actor and reason required'; end if;
  select config,revision into v_config,v_revision from pricing_versions where org_id=p_org_id and id=p_version_id;
  if not found then raise exception 'pricing version not available to business'; end if;
  select id into v_id from pricing_activations where org_id=p_org_id and version_id=p_version_id;
  if found then return v_id; end if;
  if p_expected_revision is distinct from v_revision or v_revision <> (select max(revision) from pricing_versions where org_id=p_org_id) then
    raise exception 'stale pricing activation'; end if;
  -- Business-wide bundles advance a monotonic effective timeline. A new start
  -- supersedes the preceding bundle at that instant without editing history.
  if exists(select 1 from pricing_activations a join pricing_versions v on v.id=a.version_id
    where a.org_id=p_org_id and (v.config->>'effectiveFrom')::timestamptz >= (v_config->>'effectiveFrom')::timestamptz) then
    raise exception 'pricing activation must advance effective timeline'; end if;
  insert into pricing_activations(org_id,version_id,actor,reason) values(p_org_id,p_version_id,p_actor,p_reason) returning id into v_id;
  return v_id;
end $$;

do $$ declare t text; r text; f regprocedure; begin
  foreach t in array array['pricing_versions','pricing_activations'] loop
    execute format('alter table %I enable row level security',t);
    execute format('revoke all on table %I from public',t);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on table %I from %I',t,r);
        if r='service_role' then execute format('grant select on table %I to service_role',t); end if;
      end if;
    end loop;
  end loop;
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in ('save_pricing_version','activate_pricing_version') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
