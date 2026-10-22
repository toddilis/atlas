-- TENANT-01a: the structural isolation surface, asserted as a whole instead of
-- per-feature. Every public table must have row level security enabled, and the
-- browser-facing roles (anon, authenticated) must hold no table privileges and no
-- function execute anywhere in public beyond the explicit allowlist below. Per-feature
-- probes already pin each entry point's own rules; this probe makes the NEXT migration
-- unable to widen the surface silently — a new table without RLS, a forgotten revoke,
-- or a function left executable fails CI here, with the object named.
create function pg_temp.surface_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT TENANT SURFACE: %',msg; end if; end $$;
do $$
declare v_offenders text;
begin
  -- Every table carries row level security.
  select string_agg(c.relname,', ' order by c.relname) into v_offenders
    from pg_class c join pg_namespace n on n.oid=c.relnamespace
    where n.nspname='public' and c.relkind='r' and not c.relrowsecurity;
  perform pg_temp.surface_assert(v_offenders is null,'tables without row level security: '||coalesce(v_offenders,''));

  -- The browser-facing roles hold no table, view or sequence privileges in public.
  select string_agg(distinct table_name||' ('||grantee||')',', ') into v_offenders
    from information_schema.role_table_grants
    where table_schema='public' and grantee in ('anon','authenticated');
  perform pg_temp.surface_assert(v_offenders is null,'anon/authenticated table grants: '||coalesce(v_offenders,''));

  -- And may execute no function in public. An entry here needs its own justification;
  -- today there are none: the console talks to the database only through the verified
  -- server-side service client, and the anon key only powers GoTrue session handling.
  select string_agg(distinct p.oid::regprocedure::text||' ('||r.rolname||')',', ') into v_offenders
    from pg_proc p join pg_namespace n on n.oid=p.pronamespace
    cross join (select unnest(array['anon','authenticated']) as rolname) r
    where n.nspname='public' and exists(select 1 from pg_roles where pg_roles.rolname=r.rolname)
      and has_function_privilege(r.rolname,p.oid,'execute');
  perform pg_temp.surface_assert(v_offenders is null,'anon/authenticated function execute: '||coalesce(v_offenders,''));

  raise notice 'OK: tenant surface — RLS on every public table; anon/authenticated hold no table privileges and no function execute in public';
end $$;
