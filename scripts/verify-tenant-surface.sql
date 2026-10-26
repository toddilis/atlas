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

  -- Every foreign key between org-scoped tables carries org_id (0050), so a row in one
  -- business cannot reference another business's data at the database level. An entry
  -- here needs its own justification; today there are none.
  select string_agg(src.relname||'.'||
      (select a.attname from pg_attribute a where a.attrelid=c.conrelid and a.attnum=c.conkey[1])
      ||' -> '||tgt.relname,', ' order by src.relname) into v_offenders
    from pg_constraint c
    join pg_class src on src.oid=c.conrelid
    join pg_class tgt on tgt.oid=c.confrelid
    join pg_namespace n on n.oid=src.relnamespace
    where n.nspname='public' and c.contype='f'
      and exists(select 1 from pg_attribute where attrelid=src.oid and attname='org_id' and attnum>0 and not attisdropped)
      and exists(select 1 from pg_attribute where attrelid=tgt.oid and attname='org_id' and attnum>0 and not attisdropped)
      and not exists(select 1 from unnest(c.conkey) k(attnum)
        join pg_attribute a on a.attrelid=c.conrelid and a.attnum=k.attnum where a.attname='org_id');
  perform pg_temp.surface_assert(v_offenders is null,'org-scoped foreign keys without org_id: '||coalesce(v_offenders,''));

  raise notice 'OK: tenant surface — RLS on every public table; anon/authenticated hold no table privileges and no function execute in public; every org-scoped foreign key carries org_id';
end $$;

-- Behavioural pin for the 0050 binding: a row in one business literally cannot point at
-- another business's data — the constraint refuses it before any entry-point discipline.
do $$
declare org_a uuid:='85000000-0000-4000-8000-000000000001'; org_b uuid:='85000000-0000-4000-8000-000000000002'; acct_b uuid;
begin
  insert into orgs(id,slug,display_name) values(org_a,'surface-a','Surface drill A'),(org_b,'surface-b','Surface drill B');
  insert into accounts(org_id,name) values(org_b,'Belongs to B') returning id into acct_b;
  begin
    insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents)
      values(org_a,acct_b,'SURF-1','draft','wholesale','NZD',100,100);
    raise exception 'ASSERT TENANT SURFACE: a cross-business reference was accepted';
  exception when foreign_key_violation then null; end;
  raise notice 'OK: tenant surface — a cross-business reference violates the foreign key itself';
end $$;
