# DATA-01: dispatched quantities and allocation contract

Implementation branch: `codex/data-01-dispatch-lines`, based on PR #22 at
`947fd3709d3bb32342e9891a121467484dfdd0b7`. The task/product contract lives in
[PR #20](https://github.com/toddilis/atlas/pull/20). This slice is not deployed and
does not create or send invoices. Independent review remains outstanding.

## Contract

`dispatch_sources` identifies an organization/provider/connection. `dispatches`
and `dispatch_lines` expose the current revision and its original order-line
relationships. Quantities are positive whole units in this first physical-dispatch
contract. Providers needing fractional units require an explicit contract extension.
An optional source occurrence time remains distinct from revision/receipt time.

The generic `project_dispatch` RPC accepts an Atlas source identity, stable order
and line keys, status, revision and normalized lines. The Shopify-specific
`project_shopify_dispatch` resolves original rows within its organization and maps
the provider payload in the same transaction as generic projection and the existing
fulfillment header. Another adapter can use the same generic contract without
Shopify tables. Businesses without shipping do not need this optional capability.

Only normalized `succeeded` dispatches with complete valid line mappings are eligible.
Other known statuses are ineligible; missing/malformed lines, missing item mappings
and unknown statuses are blocked with reasons. Unknown orders/lines raise a durable
projection failure for replay after source sync. No malformed line is silently dropped
from an otherwise eligible dispatch. `readDispatch` is an internal service read model,
not an authenticated public endpoint or a reservation.

`claim_dispatch` locks the original order, verifies the business/source and expected
revision, checks cumulative allocations against each original line's ordered quantity,
and records one stable internal invoice-part UUID and all active lines atomically.
The same claim key reuses that part; another key cannot allocate the dispatch again.
Keys and quantities are independent of configurable displayed invoice numbers.

**BILL-01 must call the claim function and persist the invoice, financial snapshot
and continuation in one SQL transaction.** It must not reserve using a standalone
TypeScript call, then create an invoice later. No agent tool or HTTP claim endpoint
is added here. Existing legacy invoices surface a reconciliation block. A pilot
still needs its new-shipment cutoff and an explicit legacy-data reconciliation.

Revision/evidence rows, allocations, parts and correction cases are immutable.
Stale observations cannot replace current quantities or the legacy header. Different
content at the same revision blocks the dispatch. A material change after allocation
retains the original allocation and creates a correction case; later observations
cannot automatically clear it or free quantities. Operator correction/credit workflows
and their UI remain future work. Tracking-only changes do not change normalized lines.

## Integration and authority

Webhook HMAC validation and the configured shop header check precede persistence.
The stored event receives organization identity from the server and its connection
binding from server configuration, overriding any payload field. Deduplication keys
include business, connection and content; contradictory same-revision deliveries
reach the conflict detector. Both bulk sync and webhook replay call the same RPC.

Replay compares the stored binding with the configured deployment. Changing an org
or shop cannot silently redirect a delayed event. Previously stored events without
the binding fail visibly and need an operator-confirmed source reconciliation.
The current Shopify canonical schema supports one shop per business, so the binding
rejects a second shop/rebinding. This is explicitly a single-business deployment
adapter, not completion of multi-tenant hosting, connection provisioning or TENANT-01.

New tables have no browser write grants/policies. The trusted service role gets reads
and bounded RPC execution, not direct mutations. These RPCs are backend primitives;
service credentials must stay behind authenticated business/job ownership. The core
does not interpret a browser-supplied organization ID as authority.

Normalized fulfillment records are barred from the old Controller draft path, which
still calculates full order quantities. This intentionally leaves drafting blocked
until BILL-01 consumes dispatched allocations and configured pricing. Existing legacy
records without normalization retain their previous behavior; they are not safe proof
of partial invoicing. Nothing here enables live billing, dispatch notification or release.

## Source semantics and limits

The adapter uses fulfillment `line_items.quantity` and resolves each `line_items.id`
against that order's original line ID. Shopify's separate `fulfillment_line_item_id`
is retained in immutable evidence; stable Atlas identity uses dispatch + original line.
Reference: [Shopify Fulfillment resource](https://shopify.dev/docs/api/admin-rest/latest/resources/fulfillment).
The existing REST adapter remains in use; supported API version and representative
redacted provider fixtures need confirming before a live pilot. No live Shopify call
or private customer data was used to establish these synthetic cases.

The order/product sync's broader source freshness, integration credential lifecycle,
approval execution and worker authority remain separate work. A read of eligible
quantities is not an approved invoice, and a dispatch feed is not an inventory balance.

## Verification and handoff - 27 September 2026

Implementation candidate `fadf255c4ee0d2dfdd81387cabe786b4a4714b70`, tree
`153fe627d16b0d7be30acd202d5f3290e921bb3c`, passed
[CI run 36305976723](https://github.com/toddilis/atlas/actions/runs/36305976723).
The [draft PR #23](https://github.com/toddilis/atlas/pull/23) description records
the final head and subsequent checks. This handoff also pins type generation to the
same `@supabase/postgres-meta@0.99.0` used by that passing run.

- Local Node 20.20.2: root typecheck, **120 tests**, root production build, console
  typecheck and production build passed. The default parallel local test launch hit
  Windows worker/memory failures; running all files with `--test-concurrency=1` passed.
  CI's normal `npm test` also passed all 120 tests with its default concurrency.
- CI passed **21 migrations**, existing SQL invariants, new dispatch/role probes,
  separate-session concurrency/interruption checks and **121 SQL/TS parity cases**.
- Types were generated against that real migrated Postgres schema and committed;
  the subsequent clean regeneration/diff check passed. Updated non-null JSON object
  annotations in existing event/approval/outbox/sync writers match the new generator;
  they do not change approval or outbox runtime behavior.
- The local host has no Postgres/pgvector: database evidence is from the actual CI
  disposable service, not a local database or a mock-only result.

The early CI candidate intentionally exposed missing generated types. After importing
the generator output, full application and database checks passed. No live data,
production credential, invoice issuance, merge or deployment was used. Independent
engineering review, actual provider fixtures and live-pilot acceptance remain open.

Reproducible verification:

- `test/dispatch_ingestion.test.ts`: real HTTP client/handlers with loopback provider
  and PostgREST fixtures, trusted context, replay, bulk sync, malformed IDs and draft guard.
- `scripts/verify-dispatch.sql`: actual migrated database, 40/60, original identities,
  duplicate/reordered revisions, correction, missing data, role grants and atomic rollback.
- `scripts/verify-dispatch-concurrency.sh`: independent database sessions racing
  claims; backend termination after allocation and before commit, followed by retry.
- Required root/web commands, fresh Postgres/pgvector migration probes, SQL/TS parity
  and the generated-type drift check are wired into CI, including this stacked base.

Next product slice: PRICING-01's business-scoped product/shipping configuration and
explained preview. BILL-01 consumes that and this dispatch contract. DATA-01 alone
does not complete the receivables milestone or its operator journey.
