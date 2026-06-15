-- 0009_seed_chart — minimum chart of accounts for the wholesale slice + reserved DTC codes.
-- Codes are seeded per-org via a function so adding a new org never requires another migration.
-- For Phase 0 we add a public helper; the API layer is expected to call it once per org during
-- onboarding.

create or replace function seed_chart_of_accounts(p_org_id uuid) returns void
language plpgsql as $$
begin
  insert into ledger_accounts (org_id, code, display_name, type) values
    -- core (wholesale)
    (p_org_id, '1000', 'Cash',                'asset'),
    (p_org_id, '1100', 'Accounts Receivable', 'asset'),
    (p_org_id, '1110', 'Stripe Clearing',     'asset'),
    (p_org_id, '2200', 'Sales Tax Payable',   'liability'),
    (p_org_id, '4000', 'Revenue — Wholesale', 'revenue'),
    -- reserved DTC codes (no DTC posting strategy yet — Phase 2/3 territory)
    (p_org_id, '4100', 'Revenue — DTC',           'revenue'),
    (p_org_id, '1120', 'Shopify Payments Clearing', 'asset'),
    -- reserved consignment codes (consignment v1.1 deferred)
    (p_org_id, '4200', 'Revenue — Consignment',     'revenue'),
    (p_org_id, '1300', 'Consignment Inventory',     'asset')
  on conflict (org_id, code) do nothing;
end $$;

-- The function is intentionally not invoked here. Onboarding (whether by API or a one-off
-- bootstrap script) is responsible for calling `select seed_chart_of_accounts(:org_id);`.
