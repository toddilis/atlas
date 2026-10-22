# Migrations — ordering and number ledger

Migrations apply strictly in filename order and are never edited after merge (see the
repository README). With multiple build tracks running in parallel, migration numbers
are **reserved per track by the integration coordinator** so concurrent branches never
collide on a number. Gaps in the sequence are therefore normal and permanent: a reserved
number that ends up unused is retired, not backfilled.

Claim a number by recording it in the current-status section of
[`docs/development/BUILD_QUEUE.md`](../../docs/development/BUILD_QUEUE.md) before
authoring the file. Do not take an unclaimed number mid-range; take the next one after
the highest reservation.

## Ledger (as of 2026-10-18, after step 4: #38, #39 and #40)

| Number | Name | Track / owner | Where it lives |
| --- | --- | --- | --- |
| 0001–0020 | substrate, Controller wholesale loop, Phase 2.5 hardening | pre-parallel history | main |
| 0021 | `dispatch_allocations` | DATA-01 | main (PR #23) |
| 0022 | `bound_actions` | AUTHZ-02 | main (PR #31) |
| 0023 | `versioned_pricing` | PRICING-01 | main (PR #28, via #35) |
| 0024 | — | **reserved, unaccounted** (1 Oct coordinator reservations; no ref holds it) | — confirm assignee or release |
| 0025 | `event_delivery` | EVENT-01 | main (PR #30, via #35) |
| 0026 | `decision_evidence` | EVIDENCE-01 | main (PR #30, via #35) |
| 0027 | `bound_invoice_policy` | AUTHZ-02 (AUTH reservation, 1 Oct) | main (PR #31) |
| 0028 | `dispatch_invoice_snapshots` | BILL-01 | main (PR #28, via #35) |
| 0029 | `scheduled_jobs` | JOBS-01 | main (PR #35) |
| 0030 | `operator_job_retry` | JOBS-01 | main (PR #35) |
| 0031 | `operator_job_dismiss` | JOBS-01 | main (PR #35) |
| 0032 | `manual_carrier_cost` | JOBS-01 (carrier costs) | main (PR #35) |
| 0033 | `operator_pricing` | PRICING-01 (step 4a) | main (PR #38) |
| 0034 | `invoice_approval_print` | BILL-01 / AUTHZ-02 (step 4b) | main (PR #39) |
| 0035 | `invoice_part_jobs` | BILL-01 / JOBS-01 (step 4c) | main (PR #40) |
| 0036 | `shopify_sync_jobs` | JOBS-01 (scheduled ingestion) | main (PR #42) |
| 0037 | `approval_console` | UI-01 (console approvals + executor job) | main (PR #43) |
| 0038 | `daily_briefings` | AI-01 (grounded narration) | main (PR #45) |
| 0039 | `assistant_exchanges` | AI-01 (read-only assistant) | main (PR #46) |
| 0040 | `operator_catalog` | CONFIG-01a (console catalogue) | main (PR #48) |
| 0041 | `operator_pause` | UI-01b (console pause/resume) | main (PR #49) |
| 0042 | `operator_connection` | CONFIG-01b (console Shopify connection) | main (PR #50) |
| 0043 | `operator_payment` | PAY-01 (console bank payment) | main (PR #51) |
| 0044 | `operator_statement` | STMT-01 (console statement generation) | main (PR #52) |
| 0045 | `business_profile` | CONFIG-01c (profile on documents) | main (PR #53) |
| 0046 | `tenant_surface` | TENANT-01a (close anon/authenticated function surface) | claimed 22 Oct (queue row), in progress |
| **0047** | **next unclaimed** | — | — |
