# Pricing and Controller billing: 1–7 October 2026

Branch `codex/pricing-billing-oct01`, isolated clone under the matching Codex task.
Starting commit `cbcb2e7620e73f1406bc8e31edb5b91687c866fb` includes DATA-01 and
architecture v0.2. The earlier `claude/pr-d-pricing-drafts` work is already merged;
its legacy resolver remains available and the versioned path extends that module.

## Reviewable slices and gates

1. Versioned deterministic pricing + immutable configuration storage: implemented
   for synthetic previews; persistence/database acceptance is pending.
2. Protected operator edit/preview/activate: waits for AUTH-01 browser acceptance
   and the AUTHZ-02 tool seam. No unprotected console write is added.
3. BILL-01 SQL transaction: implemented pending real database verification. Claims
   DATA-01 lines, creates stable suffixed parts, validates totals, stores immutable
   calculation/document content, publishes through EVENT-01 in the same transaction.
4. Approved printable output/status: pure stored-content renderer prepared; runtime
   tool/console integration waits for AUTH and EVENT/EVIDENCE acceptance.

Migrations: 0023 pricing; 0028 billing (coordinator moved billing after shared
0025–0027 dependencies; 0024 remains vacant). Shared queue, PLAN and issue_invoice.ts
are owned by other tracks. No live invoice, email, bank connection or deployment.

## Supported calculation contract

Business-wide immutable bundles contain exact product mappings, retailer bindings,
negotiated prices, quantity tiers, percentage/fixed discounts, explicit precedence
and stacking policy, currency/scale, exclusive tax, timezone, pricing date basis and
effective interval. Activations advance the effective timeline; the newest activated
start on/before the pricing instant supersedes preceding versions. End boundaries
are exclusive; an expired selected version cannot fall back to an older one.

Shipping can be disabled. Supported modes: actual cost, fixed/percentage markup,
fixed, free and reasoned manual charge. Carrier identity/cost remains separate from
customer charge. Freight is charged on every part (`per_dispatch`) or only on an order's
first drafted part (`first_part`, VICE's rule, PLAN D15); no basis depends on later dispatches.
Unknown or conflicting rules fail visibly. Only exact integer units and scale-2,
tax-exclusive configurations are supported in this slice. Service businesses can
preview pricing without Shopify, stock or shipping; non-dispatch billing is not yet
implemented. Whole-order threshold values require a trusted calculated input.

Snapshots contain input/source identities, config version, ordered/dispatched
quantities, rule explanation, override actor/reason, freight evidence, part order,
tax and terms/due date. Monetary values are decimal strings; bigint calculations
floor each percentage reduction and invoice tax. A snapshot is a copied value;
configuration changes do not mutate it. Explicit repricing/revision UI is pending.

Trusted `org_id` maps to shared `company_id`; caller IDs are not authority. The
additive `controller.invoice.drafted` v1 reader names the Invoice and calculation/
document references with equal business/revision and exact MoneyV1. It is distinct
from the legacy versionless event. Reader-first rollout is required before writers.

BILL requires `publish_platform_event` from EVENT-01. Missing publication fails the
whole claim/invoice transaction; no alternative outbox is introduced. Document
generation means only generated, never printed, packed, emailed or delivered.

## Evidence so far

Root typecheck and nine focused pricing tests passed with Node 20.20.2, `--jitless`,
bounded 1 GB heap (30 September UTC / 1 October NZ). Earlier host memory failures
are environment failures, not passed tests. Synthetic 100-unit 40/60 previews use
800 minor-unit tier price, freight 400/600, tax 4,860/7,290, totals 37,260/55,890 (the
since-removed order schedule; see the 15 October review for the D15 first-part rule);
due date 20 November. Tests cover both retailers, effective boundaries, immutable
copies, service configuration, freight modes/evidence/thresholds, conflicts and
amounts above JavaScript safe-integer precision. Database, browser, full CI and
independent review remain pending and must be attached to the actual candidate.

Real commercial values, numbering policy, terms anchor, carrier examples and pilot
cutoff remain onboarding gates. Synthetic values do not establish VICE policy.
Bank reconciliation is stretch after the core journey.

## 4 October checkpoint

Draft [PR #28](https://github.com/toddilis/atlas/pull/28) preserves the first candidate
`6d54900c618de9f69e80d7eea184ba3bd4372dda`. Independent reviewer F7 found that the
SQL accepted internally consistent but unconfigured prices. `e103666` added independent
SQL rule/price/freight/terms verification and source-time checks; its first SQL run
caught JSONB operator precedence in the new terms check. Replacement
`3f5123db711f8fe00d3418b97109c0ad345e82a0` fixes that and adds trusted internal adapters.
[CI 37187061736](https://github.com/toddilis/atlas/actions/runs/37187061736) passed
root and console tests/builds, migrations including the forged-money/terms/date probes,
and DATA concurrency. Only generated-type drift failed; parity was consequently skipped.
Types are copied from that run's disposable database artifact in the next candidate.

The preserved September `atlas-pricing` checkout was compared read-only. Its editor
flow and regression scenarios are reused, while this branch retains one configuration
store/calculator. New regression cases cover effective version supersession, import
retry, negotiated prediscount thresholds, increased overrides, zero freight allocation
and escaped immutable print content. The staged PricingEditor component has no route
or server callback wired until AUTH-01 acceptance.

Persisted manual price/freight overrides and whole-order thresholds currently refuse
with explicit dependency errors; they need a protected exception/whole-order calculation
source. Their pure previews are implemented, not a claim of persisted workflow support.
Canonical dispatch time is required; order-date persisted billing presently verifies
Shopify placed_at. Other source adapters use dispatch-date pricing until they provide
authoritative order time. Arbitrary carrier evidence/terms are still proposed inputs;
live evidence adapters and operator-authorized exception attribution remain gates.

The standalone SQL suite tests rollback when EVENT is absent and explicitly reports
the successful BILL journey blocked. The coordinator authorized a separate integration
rehearsal using EVENT `07e578f07d0aaa58d6a339fe607764862bc8f143` and AUTH
`2179d8c8f4bb6662a68a0f8d9dc78e78725f1a99`; neither that rehearsal nor this draft is
acceptance of AUTH's pending browser tests, provider operation or deployment.

## 15 October: F7 closed at the draft boundary

#30 (EVENT/EVIDENCE, carrying #31 AUTH) is merged in, so `verify-pricing.sql` drafts the
40/60 parts against a real database instead of reporting BLOCKED. #28 now lands after
#31 and #30, as PLAN D14 orders them.

Before this change the service draft accepted six internally consistent forgeries: a
typed-in carrier quote, a typed-in actual carrier cost, an unverified destination, a
chosen due day, an invoice anchor with a chosen invoice date and explicit terms naming
any actor. Now:

- Standard payment terms are versioned configuration (`terms`: following-month day and
  anchor). Calculator and SQL reject any other day or anchor; invoice-anchored terms must
  use the draft's own date. The 20th and its anchor remain synthetic until onboarding.
- Owner-selected (explicit) terms, carrier quotes with actual/adjusted freight, and
  destination claims or destination-scoped rules are refused when persisting, until the
  protected exception seam, stored carrier evidence and an authoritative dispatch
  destination exist. Previews still calculate them.
- `verify-pricing.sql` sends 13 forged drafts (price, freight, effective date, terms)
  through the service-role draft. Each is refused and leaves no part, allocation, order
  group, invoice, snapshot or event. It then drafts A/B and prints them, and covers
  retries (including a forged retry), a scheduled price change and a stale preview for
  a later dispatch.
- `verify-bill-concurrency.sh` (CI): A and B drafted concurrently; the same dispatch
  drafted twice concurrently; a drafting session killed before commit, then recovered.

The limits listed here at the time (retailer binding, staggered freight, carrier evidence)
are addressed in the review section below.

## 15 October review of `63ade52`

`9098ec6` fixed the small findings: the content hash uses built-in `sha256` (hosted Supabase
keeps pgcrypto in `extensions`), the due date compares independent of DateStyle, and stored
snapshots carry no extra input lines and only the product's own name. #30 `2cc0c1e` brings
#31's hosted-layout CI check and the same hash change for 0022/0026.

Owner decisions applied in the following commit:

- **Retailer:** the draft derives the billed account from the order (Shopify customer link)
  and refuses a different, unknown or unlinked one, and a non-Shopify source, until that
  source has an order account contract. The order's currency must match the pricing.
- **Freight (PLAN D15):** `first_part` charging basis. Only an order's first drafted part
  carries freight; later parts carry none. The part order (`priorParts`) is checked under
  the order lock, so concurrent drafts admit one first part and the other is refused as
  stale. `order_schedule`, which named future dispatches, is removed.
- **Carrier cost:** `carrier_cost_evidence` holds carrier quotes recorded by the carrier
  adapter through `record_carrier_cost` (idempotent, append-only). Actual/adjusted freight
  needs one, and any quote in a snapshot must be the latest unexpired record for that
  dispatch. The GoSweetSpot adapter that records them is not built yet.
- **Tax:** `taxExempt` is a calculation input checked against `accounts.tax_exempt`;
  exempt retailers are charged no tax and the snapshot records the applied rate.
- **Legacy path:** a BILL draft refuses a fulfillment that has a legacy invoice; a trigger
  refuses a legacy invoice for a fulfillment BILL has claimed (try-lock, so no deadlock);
  `draft_invoice_atomic` is service-only.
- **Rule precedence:** a retailer-specific negotiated price, tier or single discount
  outranks a general one; two rules of the same scope are rejected by the schema.
- Snapshots must have the exact expected shape, so no unverified fields are stored.

Still open: part suffixes follow drafting order; the printed document is a placeholder
(account id, no supplier details or invoice date); explanation text in a snapshot is not
re-derived; every draft takes the org-wide pricing lock; backdated activations and SQL-side
configuration validation at save are not addressed.

## GoSweetSpot carrier cost adapter

`src/integrations/gosweetspot/consignment.ts` maps a GoSweetSpot shipment response to carrier
cost evidence and records it with `record_carrier_cost`:

- It uses only the documented response fields: each consignment's `ConsignmentId`, `Connote` and
  `Cost` (dollars, excluding tax).
- A dispatch's consignments are those whose connote is one of its Shopify fulfillment tracking
  numbers. Every tracking number must be covered, so a partial response records nothing. A
  dispatch shipped as several consignments records their summed cost once.
- Costs convert to cents exactly; more than two decimals is refused, never rounded.
- The site, its cost currency and how long a recorded cost may be used are business
  configuration. No currency is assumed.
- The pricing probe's carrier quotes come from this mapping, so the database accepts exactly
  what it produces.

VICE books shipments in the GoSweetSpot website (confirmed 15 October), so Atlas reads them
back. `src/integrations/gosweetspot/client.ts`:

- `fetchShipmentsByConnote` calls `GET https://api.gosweetspot.com/api/shipments?shipments=<connotes>`
  with the `access_key` and `site_id` headers.
- `syncGoSweetSpotCost` takes a dispatch's Shopify tracking numbers, looks up the matching
  shipments and records their cost.

The response is accepted only in the documented shipment shape (`Consignments` with
`ConsignmentId`, `Connote`, `Cost`); any other shape records nothing.

GoSweetSpot writes its connotes to the Shopify fulfillment as tracking numbers (confirmed by
VICE, 16 October), which is the link the lookup matches on. Still to confirm with VICE's
account: that the GET returns that shape (one webhook sample instead shows `TotalCost`), and
the site id. VICE's GoSweetSpot costs are in NZD (confirmed 16 October); that is VICE's
connection setting, not a platform default.

Settings are server environment (`.env.example`): `GOSWEETSPOT_ACCESS_KEY` is a server secret
(worker/API host secret store only, never `NEXT_PUBLIC_`, never logged), plus
`GOSWEETSPOT_SITE_ID`, `GOSWEETSPOT_COST_CURRENCY` (VICE: `NZD`) and
`GOSWEETSPOT_COST_VALIDITY_DAYS` (default 30). Missing settings fail closed.
`syncGoSweetSpotCostFromEnv` runs the lookup with them. No live call has been made.

## 16 October: JOBS-01 core runs the cost sync

The worker now runs the sync on each tick without anyone calling an endpoint (0029,
`src/platform/jobs/carrier-cost.ts`). This is the JOBS-01 core plus its first job kind. It
does not cover Shopify ingestion scheduling, approval-expiry sweeps or rollups.

- `discover_carrier_cost_jobs` records one `scheduled_jobs` row per business for each
  eligible Shopify dispatch that meets all of these conditions:
  - its fulfillment has tracking numbers;
  - its order has no invoice snapshot yet;
  - it has no unexpired carrier cost.
  Discovery is idempotent. A succeeded job is re-armed when its cost has expired and the
  order is still unbilled.
- `claim_scheduled_job` leases one due job (skip locked, 5 minutes). If a worker crashes,
  its lease expires; the expiry is recorded in `job_runs` and the job is claimed again.
  `finish_scheduled_job` accepts only the current lease holder. It sets the outcome as
  follows:
  - transient errors retry with a backoff of 2, 4, 8 … minutes, capped at 6 hours;
  - errors a person must fix are `blocked`, with their reason in `last_error`, and are tried
    again after 6 hours. These are missing settings, an unreadable response, an uncovered
    tracking number and HTTP 401/403;
  - after 8 attempts the job is `quarantined`.
  `job_runs` is append-only and holds one row per attempt.
- The sync is an optional module: it runs only when `GOSWEETSPOT_ACCESS_KEY` is set. A
  business without GoSweetSpot gets no jobs.
- Evidence: `scripts/verify-jobs.sql` in the database CI job tests discovery, leases, stale
  finishes, backoff, blocked reasons, crash recovery, quarantine, re-arming, append-only
  runs and service-only grants. `test/carrier_cost_jobs.test.ts` tests the runner and the
  classification.
- Limits:
  - Operators retry quarantined or blocked jobs from the console (see the next sections).
  - Live use still needs VICE's GoSweetSpot site id and one real response, to confirm the
    cost field.

## 16 October: console view of background jobs

`/jobs` in the console (linked in the header and from home) is a read-only view for the
signed-in operator, scoped to the business by `ATLAS_ORG_ID`. It shows:

- counts by state;
- **Needs a person**: quarantined jobs first, then blocked ones. Each shows the order,
  dispatch and tracking numbers, the recorded reason, what to do about it, the next attempt
  and the attempt history;
- **Retrying** and **Queued and running**;
- an overdue warning when due work has not been picked up for more than 10 minutes, which
  means the worker is down or GoSweetSpot has been switched off;
- an empty state, and the console's existing error page when a read fails.

The view logic is in `web/lib/jobs.ts`, with unit tests in `web/test/jobs.test.ts`. The
browser acceptance seeds one job of each state plus another business's blocked job. It
checks what the operator sees and that the other business's job never appears.

Limits:

- Freshness is inferred from job runs. It is not a worker heartbeat.

## 16 October: operator retry for stopped jobs

Each job under **Needs a person** has a **Retry now** form that asks what was fixed. The
form posts to `/jobs/retry`, which checks the operator's session, the allowlist and same
origin, then calls `retry_scheduled_job` (0030, service-only). The database:

- enforces the action pause and the operator's `operator → jobs.retry` tool grant. Boot
  seeds the grant once; setting `enabled=false` revokes it and the page then explains that
  retry is switched off;
- refuses a retry when:
  - the job changed since the page loaded (a stale tab or a double submit);
  - the job is no longer blocked or quarantined;
  - the reason or operator identity is missing;
  - the dispatch no longer needs a cost (it has an unexpired cost, the order is invoiced,
    or the dispatch is no longer eligible);
- otherwise sets the job back to `pending` with its attempts reset, and records it in two
  places:
  - an `operator_retry` row in `job_runs`;
  - a `jobs.retry` row in `audit_log`, with the operator, reason, previous state, previous
    attempts and previous error.

The console shows a fixed message for each outcome. Nothing from the URL is echoed back.

Evidence:

- `verify-jobs.sql` tests every refusal, the recorded evidence and the service-only grant.
- The browser acceptance:
  - retries the seeded quarantined job with a reason and sees it queued;
  - replays the old form and gets "changed";
  - checks a cross-site post is refused (403).

Limits:

- There is no dismiss action for a job that will never succeed.
- Refused retries are shown to the operator but not written to `audit_log`.
