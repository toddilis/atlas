-- TENANT-01a follow-up: close the browser-facing TABLE and SEQUENCE surface wherever
-- the hosting platform's defaults opened it. 0046 swept functions and flipped their
-- default privileges, and migrations from 0034 on revoked the tables they created —
-- but tables from 0001–0033 kept whatever the platform granted at creation. On a bare
-- CI cluster that is nothing, so scripts/verify-tenant-surface.sql passed; on a managed
-- Supabase project the platform's default privileges grant anon and authenticated on
-- every table and sequence a migration creates, so the surface the probe declares
-- closed was open on the live project: row level security (enabled everywhere,
-- policy-less for the browser roles) kept every row unreadable, but the grants let the
-- anon key enumerate table and column names through the data API. Found by running the
-- probe's assertions against the live project in the go-live link-up test, 7 November
-- 2026 — 472 table grants and 4 sequence grants that no CI cluster could ever show.
--
-- The sweep revokes PUBLIC, anon and authenticated on every table (views included) and
-- sequence in public, and flips this role's default privileges so future ones are born
-- closed on platforms whose defaults differ from a bare cluster. service_role is
-- untouched: the API, worker and console reach the database only through it. Idempotent
-- everywhere; a no-op on CI. scripts/verify-tenant-surface.sql now also asserts the
-- sequence surface, so CI names any future regression.

do $$ declare r text; begin
  execute 'revoke all on all tables in schema public from public';
  execute 'revoke all on all sequences in schema public from public';
  execute 'alter default privileges in schema public revoke all on tables from public';
  execute 'alter default privileges in schema public revoke all on sequences from public';
  foreach r in array array['anon','authenticated'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on all tables in schema public from %I', r);
      execute format('revoke all on all sequences in schema public from %I', r);
      execute format('alter default privileges in schema public revoke all on tables from %I', r);
      execute format('alter default privileges in schema public revoke all on sequences from %I', r);
    end if;
  end loop;
end $$;
