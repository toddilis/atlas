-- Where is this database? Read-only: paste into the Supabase SQL editor (or psql) against
-- the live project before applying migrations (docs/operations/GO_LIVE.md, step 2). Each
-- migration is checked by an object it first introduced; "applied" is false for every
-- migration still to apply, in order. A migration with no object of its own (it only
-- changes privileges, constraints or function bodies) shows kind "none" and an empty
-- "applied": count it as applied when the migration after it is.
-- scripts/verify-migrations.sh fails CI if a migration is missing from this list or a
-- marker is absent on a fully migrated database.
with markers(migration, kind, name) as (values
  ('0001_core','table','orgs'),
  ('0002_canonical_shopify','table','shopify_customers'),
  ('0003_billing','table','fulfillment_events'),
  ('0004_ledger','table','ledger_accounts'),
  ('0005_consignment','table','consignment_movements'),
  ('0006_control_plane','table','approvals'),
  ('0007_platform','table','event_log'),
  ('0008_memory','table','observations'),
  ('0009_seed_chart','function','seed_chart_of_accounts'),
  ('0010_security_hardening','none',''),
  ('0011_policy_rules','table','policy_rules'),
  ('0012_pr_c_atomic_invoice','column','accounts.stripe_customer_id'),
  ('0013_pr_d_pricing_drafts','table','invoice_counters'),
  ('0014_pr_e_gst','column','orgs.gst_rate_bps'),
  ('0015_pr_f_statements','table','statements'),
  ('0016_draft_invoice_state_qualifier','none',''),
  ('0017_projection_durability','table','event_projections'),
  ('0018_payment_atomicity','column','payments.posted_at'),
  ('0019_control_plane_integrity','column','approvals.executed_at'),
  ('0020_statement_correctness','column','statements.aging_90_cents'),
  ('0021_dispatch_allocations','table','dispatch_sources'),
  ('0022_bound_actions','table','action_controls'),
  ('0023_versioned_pricing','table','pricing_versions'),
  ('0025_event_delivery','table','platform_events'),
  ('0026_decision_evidence','table','evidence_observations'),
  ('0027_bound_invoice_policy','none',''),
  ('0028_dispatch_invoice_snapshots','table','billing_order_groups'),
  ('0029_scheduled_jobs','table','scheduled_jobs'),
  ('0030_operator_job_retry','function','retry_scheduled_job'),
  ('0031_operator_job_dismiss','function','dismiss_scheduled_job'),
  ('0032_manual_carrier_cost','function','record_manual_carrier_cost'),
  ('0033_operator_pricing','function','assert_pricing_references'),
  ('0034_invoice_approval_print','table','invoice_print_outcomes'),
  ('0035_invoice_part_jobs','function','dispatch_routed_wholesale'),
  ('0036_shopify_sync_jobs','column','dispatch_sources.sync_every_minutes'),
  ('0037_approval_console','column','scheduled_jobs.action_id'),
  ('0038_daily_briefings','table','daily_briefings'),
  ('0039_assistant_exchanges','table','assistant_exchanges'),
  ('0040_operator_catalog','column','products.updated_at'),
  ('0041_operator_pause','function','operator_set_action_pause'),
  ('0042_operator_connection','column','dispatch_sources.updated_at'),
  ('0043_operator_payment','column','payments.reference'),
  ('0044_operator_statement','function','operator_generate_statement'),
  ('0045_business_profile','table','business_profiles'),
  ('0046_tenant_surface','none',''),
  ('0047_statement_lifecycle','column','statements.sent_by'),
  ('0048_invoice_void','column','invoices.voided_at'),
  ('0049_org_members','table','org_members'),
  ('0050_tenant_fk_binding','none',''),
  ('0051_bank_source','table','bank_accounts'),
  ('0052_bank_receipt_matching','table','bank_receipt_allocations'),
  ('0053_payment_reminders','table','payment_reminders'),
  ('0054_customer_invoicing_decisions','column','shopify_customers.do_not_invoice')
)
select migration, kind, name,
  case kind
    when 'table' then to_regclass('public.' || name) is not null
    when 'function' then exists(select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                where n.nspname = 'public' and p.proname = name)
    when 'column' then exists(select 1 from information_schema.columns
                              where table_schema = 'public' and table_name = split_part(name, '.', 1)
                                and column_name = split_part(name, '.', 2))
  end as applied
from markers
order by migration;
