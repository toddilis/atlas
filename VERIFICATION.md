# Phase 0 Verification

> **Historical record (2026-06).** This documents the original one-off Phase 0 proof
> against a live Supabase project, covering migrations 0001–0010 and the 6-test suite of
> the time. Verification is now living and repeatable: CI applies every migration to a
> real Postgres and runs behavioural suites on each push — see the Verification section
> of `README.md`, `scripts/verify-migrations.sh`, `scripts/sql-ts-parity.ts`, and
> `PLAN.md` §5 (PR-M). Nothing below is maintained.

This document records the proof that Phase 0 of the Atlas build plan meets its
verification criteria. Verification was run against a fresh Supabase project
(`Atlas`, organisation `VICE`, region `ap-southeast-1`) provisioned via the
Supabase MCP tool, with migrations `0001`–`0010` applied in order.

## 1 · typecheck

```
$ npm run typecheck
> tsc -p tsconfig.json --noEmit
(no errors)
```

## 2 · unit tests

```
$ npm test
tests:    6 / 6 pass
suites:   0
duration: ~470 ms
```

Covers HMAC verification (positive + negative + missing-header) and the three
env-driven routing branches (venue / unknown / missing location id).

## 3 · migrations apply clean

All 10 migrations applied via `mcp__supabase__apply_migration` returned
`{success: true}`:

| Migration | Subject |
|---|---|
| `0001_core` | orgs, accounts, products, price_books |
| `0002_canonical_shopify` | customers, orders, lines, fulfillments (Seams 1 & 2) |
| `0003_billing` | fulfillment_events, invoices, lines, payments |
| `0004_ledger` | accounts, transactions, lines + balance trigger (Seam 3) |
| `0005_consignment` | consignment_movements |
| `0006_control_plane` | approvals, audit_log + risk/state enums |
| `0007_platform` | event_log, agents, activity, tasks, tool_grants, outbox |
| `0008_memory` | observations, semantic_facts/episodic_summaries stubs + pgvector |
| `0009_seed_chart` | `seed_chart_of_accounts(p_org_id)` |
| `0010_security_hardening` | search_path pinning + move `vector` to extensions schema |

29 tables in `public`, all with RLS enabled.

## 4 · extension + trigger verification

```sql
-- vector extension
select extname, extversion from pg_extension where extname = 'vector';
-- ('vector', '0.8.0')

-- triggers
select tgname, tgrelid::regclass from pg_trigger
where tgname in ('ledger_balance_check',
                 'event_log_immutable_update',
                 'event_log_immutable_delete');
-- ledger_balance_check         | ledger_lines
-- event_log_immutable_update   | event_log
-- event_log_immutable_delete   | event_log
```

Live behavioural proof:

- **Unbalanced ledger transaction rejected** — inserting two lines summing to
  +5000 cents raises `ledger imbalance: transaction <id> lines sum to 5000
  (must be 0)`.
- **Balanced ledger transaction commits** — two lines summing to 0 land
  cleanly; `select sum(amount_cents) … = 0`, line count = 2.
- **event_log UPDATE blocked** — raises `event_log is append-only; UPDATE
  blocked`.
- **event_log DELETE blocked** — raises `event_log is append-only; DELETE
  blocked`.

## 5 · generated types compile

`mcp__supabase__generate_typescript_types` output written to
`src/data/database.types.ts` (53 kB). `tsc --noEmit` succeeds against the
generated types.

## 6–8 + 10 · spine, seam-1, routing, memory integration

Test fixture seeded into the live project:

| Object | Detail |
|---|---|
| Account | `Club Acme`, 14-day terms |
| Shopify customer (B2B) | `shopify_cust_b2b_001`, linked → `Club Acme` |
| Shopify customer (DTC) | `shopify_cust_dtc_002`, no account link |
| Order — B2B main loc | `sh_order_b2b_1001` → fulfillment `sh_ful_b2b_2001` at `loc_main_999` |
| Order — DTC main loc | `sh_order_dtc_1002` → fulfillment `sh_ful_dtc_2002` at `loc_main_999` |
| Order — B2B venue loc | `sh_order_venue_1003` → fulfillment `sh_ful_venue_2003` at `loc_venue_111` |

Then the same logic the controller's `onShopifyFulfillmentCreated` performs
was run via SQL: route resolution → `fulfillment_events` upsert →
`event_log.controller.fulfillment.routed` append → `agent_activity` write →
`observation` write (linked to the source event).

14 integration assertions returned PASS:

| Assertion | PASS |
|---|---|
| `seam1.dtc_customer_in_canonical` | ✅ |
| `seam1.dtc_order_in_canonical` | ✅ |
| `seam1.dtc_fulfillment_routed_ignored` | ✅ |
| `seam1.dtc_fulfillment_account_null` | ✅ |
| `routing.b2b_main_to_wholesale` | ✅ |
| `routing.b2b_main_has_account_id` | ✅ |
| `routing.venue_to_consignment` | ✅ |
| `routing.dtc_to_ignored` | ✅ |
| `spine.three_routed_events_appended` | ✅ |
| `spine.events_have_unique_idempotency_keys` | ✅ |
| `spine.event_payload_matches_projection` | ✅ |
| `memory.three_observations_with_source_event_id` | ✅ |
| `memory.observation_source_event_resolvable` | ✅ |
| `memory.activity_links_to_event` | ✅ |

### Replay idempotency

Re-running the routing function for `sh_ful_b2b_2001` triggered the
`event_log.idempotency_key` unique constraint, rolling back the entire
transaction. State after the failed replay was unchanged:

| Assertion | PASS |
|---|---|
| `replay.events_unchanged` (still 3 routed events) | ✅ |
| `replay.fulfillment_events_unchanged` (still 3 routed fulfillments) | ✅ |
| `replay.observations_unchanged` (still 3 observations) | ✅ |

This is the exact behaviour `appendEvent` in `src/platform/events/eventLog.ts`
relies on: the constraint fires, the prior row is returned, no duplicate state
is produced.

## 9 · contract + outbox test — deferred to Phase 1

This task exercises `issue_invoice` (Phase 1 deliverable) through the approval
gate and the transactional outbox. The control plane + outbox tables are
present and the JS helpers (`requestApproval`, `audit`, `enqueue`, `drain`) are
implemented in Phase 0; the test target — `issue_invoice` as a registered tool
— is built when the invoice state machine + ledger posting engine ship in
Phase 1.

## 11 · deterministic boundary

```
$ rg --pcre2 -n "^import.*anthropic|from ['\"]@anthropic-ai" src
src/integrations/anthropic/client.ts:5:import Anthropic from '@anthropic-ai/sdk';
```

The only file that imports the Anthropic SDK is the dedicated client.
Money-path code (events, projector, registry, routing, controller,
observations, tools/outbox, control-plane) has zero references. Phase 0 paths
are clean; the full pricing/ledger boundary is verified end-to-end in Phase 1
when those code paths exist.

## Supabase security advisor

After `0010_security_hardening`:

```
$ mcp__supabase__get_advisors --type security
{ lints: [] }
```

The four findings from the initial run (mutable `search_path` on
`enforce_ledger_balance`, `block_event_log_mutation`,
`seed_chart_of_accounts`; `vector` extension in `public`) are all resolved.
