-- 0010_security_hardening — addresses the Supabase advisor's WARN-level findings.
--
-- 1. Pin search_path on every plpgsql function we own. Without this, a privileged caller
--    could redirect references like `ledger_lines` to a same-named object in a malicious
--    schema set on their session search_path. Pinning to pg_catalog, public makes the
--    function reference the intended objects unambiguously.
-- 2. Move the `vector` extension out of `public` into a dedicated `extensions` schema so
--    application-owned tables/types don't share a namespace with extension-owned operators.
--    pgvector relocates cleanly because all its operator class names remain referenced via
--    type names rather than schema-qualified paths in our DDL.

-- 1) search_path pinning. Recreate functions with `set search_path` and `security definer
--    off` (default), to ensure they run as the invoking role under a known search_path.

create or replace function enforce_ledger_balance() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
declare
  txn_id uuid := coalesce(new.transaction_id, old.transaction_id);
  total  bigint;
begin
  select coalesce(sum(amount_cents), 0) into total
  from ledger_lines
  where transaction_id = txn_id;

  if total <> 0 then
    raise exception
      'ledger imbalance: transaction % lines sum to % (must be 0)', txn_id, total;
  end if;
  return null;
end $$;

create or replace function block_event_log_mutation() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'event_log is append-only; % blocked', tg_op;
end $$;

create or replace function seed_chart_of_accounts(p_org_id uuid) returns void
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  insert into ledger_accounts (org_id, code, display_name, type) values
    (p_org_id, '1000', 'Cash',                'asset'),
    (p_org_id, '1100', 'Accounts Receivable', 'asset'),
    (p_org_id, '1110', 'Stripe Clearing',     'asset'),
    (p_org_id, '2200', 'Sales Tax Payable',   'liability'),
    (p_org_id, '4000', 'Revenue - Wholesale', 'revenue'),
    (p_org_id, '4100', 'Revenue - DTC',           'revenue'),
    (p_org_id, '1120', 'Shopify Payments Clearing', 'asset'),
    (p_org_id, '4200', 'Revenue - Consignment',     'revenue'),
    (p_org_id, '1300', 'Consignment Inventory',     'asset')
  on conflict (org_id, code) do nothing;
end $$;

-- 2) Move `vector` into a dedicated extensions schema. The columns + indexes on
--    observations / semantic_facts / episodic_summaries already reference the type by
--    unqualified name; once the extension moves, Postgres resolves the type via search_path
--    (which is `pg_catalog, "$user", public, extensions` by default in Supabase).

create schema if not exists extensions;
alter extension vector set schema extensions;
