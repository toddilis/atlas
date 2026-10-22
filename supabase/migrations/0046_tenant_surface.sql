-- TENANT-01a: close the browser-facing function surface. Postgres grants EXECUTE on new
-- functions to PUBLIC by default, and while per-feature migrations revoked their own
-- entry points, dozens of earlier functions (payment posting, statement derivation,
-- chart seeding, invoice numbering, the pgcrypto family) stayed executable by the
-- browser-facing roles through that default. Row level security limited what they could
-- actually reach, but the surface itself must not exist before any second business
-- shares an environment.
--
-- The sweep revokes PUBLIC/anon/authenticated on every routine in public, and re-grants
-- service_role only where it already had execute (directly or via PUBLIC) — so the
-- deliberate per-feature exclusions of internal helpers stay excluded, and every
-- service-side caller keeps working. Trigger functions get no grant: firing does not
-- check EXECUTE. Finally, default privileges flip so FUTURE functions are born without
-- PUBLIC execute; scripts/verify-tenant-surface.sql fails CI if the surface ever widens.

do $$
declare
  f regprocedure; is_trigger boolean; had_service boolean; r text;
  has_service boolean := exists(select 1 from pg_roles where rolname='service_role');
begin
  for f, is_trigger, had_service in
    select p.oid::regprocedure, p.prorettype = 'trigger'::regtype,
           case when exists(select 1 from pg_roles where rolname='service_role')
                then has_function_privilege('service_role', p.oid, 'execute') else false end
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
  loop
    execute format('revoke all on routine %s from public', f);
    foreach r in array array['anon','authenticated'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on routine %s from %I', f, r);
      end if;
    end loop;
    if has_service and had_service and not is_trigger then
      execute format('grant execute on routine %s to service_role', f);
    end if;
  end loop;
  execute 'alter default privileges in schema public revoke execute on functions from public';
end $$;
