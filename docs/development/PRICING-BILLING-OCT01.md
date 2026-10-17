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
  order is still unbilled. The precondition is one SQL function, `carrier_cost_job_needed`,
  shared by discovery, claims, retry and manual cost. A pending, failed, blocked or
  quarantined job whose dispatch no longer needs a cost (it has one, its order is invoiced,
  or it is no longer eligible) is closed as done with a `not_needed` run, so it neither
  calls GoSweetSpot again nor waits for a person.
- `claim_scheduled_job` leases one due job (skip locked, 5 minutes). It claims nothing while
  business actions are paused, and closes a due job that is no longer needed instead of
  leasing it. If a worker crashes, its lease expires; the expiry is recorded in `job_runs`
  and the job is claimed again. A GoSweetSpot lookup times out after 30 seconds, well inside
  the lease, and a run that cannot be finished does not stop the other due jobs.
- Each sync records a new observation: its quote key is the consignment ids plus the
  observation time. A re-sync after a cost expires therefore adds evidence instead of
  conflicting with the expired row. A consignment reported with a zero cost is treated as
  not yet priced (retried), never as free freight; identical duplicate consignments count
  once and conflicting ones are blocked.
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

- Refused actions are shown to the operator but not written to `audit_log`.

## 16 October: operator dismissal for jobs that will never succeed

Blocked and quarantined cards also have **Dismiss**. It uses the same reason box and posts
to `/jobs/dismiss`; both actions share `web/lib/job-action.ts`. `dismiss_scheduled_job`
(0031, service-only) applies the same checks as retry, against its own
`operator → jobs.dismiss` grant (seeded at boot): pause, grant, an unchanged job, a reason
and the operator's identity. Only blocked or quarantined jobs can be dismissed.

A dismissed job:

- keeps its last error;
- is never claimed;
- is not re-armed by discovery;
- records no carrier cost. If its dispatch is the order's first part, that part still
  cannot be drafted until a cost is recorded; the page says so.

Each dismissal is recorded as an `operator_dismiss` row in `job_runs` and a `jobs.dismiss`
row in `audit_log`. Dismissed jobs are listed under **Dismissed**, where **Retry now** undoes
the dismissal (`retry_scheduled_job` now also accepts `dismissed`).

Evidence:

- `verify-jobs.sql` tests:
  - the refusals: no grant, wrong state, no reason, a stale view, paused;
  - the recorded evidence;
  - that a dismissed job is never claimed or re-armed and records no cost;
  - undo by retry;
  - service-only access.
- The browser acceptance dismisses the seeded blocked job with a reason. It checks the job
  moves to Dismissed with the warning and its history, then undoes it with Retry now.

## 16 October: manual carrier cost for dismissed jobs

**Decision (owner request, 16 October).** A parcel that never went through GoSweetSpot (a
hand courier, say) can have its actual carrier cost entered by an operator, so its order's
first part can still be drafted under D15.

This is the one deliberate exception to "a draft never uses a typed-in cost". The typed
amount becomes stored carrier evidence through a separate, attributed operator action. It
never becomes a draft input. Draft callers still cannot supply a cost.

How it works:

- **Where.** Dismissed carrier cost jobs have an **Enter the carrier cost by hand** form,
  which asks for:
  - the amount, excluding tax, in the order's own currency;
  - an optional reference;
  - a required reason.
  The form posts to `/jobs/cost`, and the database function is `record_manual_carrier_cost`
  (0032, service-only).
- **Checks.** The database requires:
  - the business's `carriers.record_manual_cost` operator grant. Boot does **not** seed it;
    a business turns it on deliberately, and until then the form explains it is off. Once
    on, any signed-in operator of that business may use it: it is not per person. A grant
    set to `approve_required` is refused, because no approval step exists for it yet;
  - the action pause to be off;
  - a dismissed job, unchanged since the page loaded;
  - a dispatch that is still eligible, in an unbilled order, with no unexpired cost;
  - an amount of digits with at most two decimals. The amount stays a string until the
    database converts it to minor units.
- **What is stored.** It is written through `record_carrier_cost` as connection
  `manual:operator` with a unique quote key. The currency comes from the Shopify order and
  the tax basis is exclusive. It stays valid for 365 days, because it is an actual cost,
  not a quote. Its evidence holds the operator, reason, reference and the amount as typed.
- **After recording.** The job becomes `succeeded`, and the action is recorded as an
  `operator_cost` row in `job_runs` and a `carriers.record_manual_cost` row in `audit_log`
  (subject: the dispatch). The draft treats it like any latest stored carrier cost; its
  snapshot names `manual:operator`, so the invoice calculation shows that the cost was
  entered by hand.

Evidence:

- `verify-pricing.sql` drafts a later order's first part from a manual cost end to end:
  the part bills 10.00 freight and its snapshot names `manual:operator`.
- `verify-jobs.sql` tests:
  - a grant that requires approval;
  - no grant, malformed amounts (`12.345`, `-1`, `1,50`, `1e3`, `.5`, ten digits), no
    reason, a stale view, paused, wrong state, and an already-costed dispatch;
  - that the stored evidence is exact and is the dispatch's latest;
  - the job state, its history and the audit row;
  - that discovery does not re-sync it;
  - service-only access.
- The browser acceptance dismisses a seeded courier job, has the browser refuse `12.345`,
  then records `18.40` with a reference. The stored evidence was NZD 1840 minor units,
  `manual:operator`, with the operator email, reason and reference.

Limits:

- The draft's stored-cost check has no connection-specific rule: a manual cost is used
  like any other latest stored cost (the end-to-end draft above shows it).
- Once recorded, a manual cost cannot be corrected in the console. A wrong amount needs a
  new evidence record, through a correction path that does not exist yet.
- Cost entry is offered only for dismissed jobs, not for blocked or quarantined ones.

## 17 October: pricing editor in the console (step 4a)

`/pricing` is the PRICING-01 operator journey: edit a draft of the next version, preview a
retailer's charge, save it as a version, preview the saved version and activate it.

- **What can be edited.** Version name and identifier, effective from/until and timezone,
  pricing-date basis, currency, tax rate, whether freight is taxed, payment terms, price
  precedence, the volume-tier quantity basis, the fallback for retailers without a book,
  discount combination; price books and their products; retailer books; negotiated
  prices, volume tiers and discounts (retailer or all retailers); shipping rules (scope,
  priority, charge mode, partial-order basis, a per-shipment free threshold).
- **First version.** Every choice that changes what a retailer pays starts empty, and the
  draft cannot be saved until the schema accepts every field. A next version starts from
  the latest saved one with no start time, since it activates only if it starts after the
  version in effect.
- **Preview.** The browser runs the shared calculator on a hypothetical order of the
  chosen retailer (lines, dates, an optional carrier cost standing in for stored
  evidence, earlier parts), and compares it with the version in effect.
- **Save and activate** (`0033`). The console verifies the operator (session, allowlist,
  same origin) and checks the draft against the schema with the business forced to the
  operator's own. `operator_save_pricing_version` and `operator_activate_pricing_version`
  enforce action pause and the business's `pricing.save` / `pricing.activate` operator
  grants (seeded at boot, revocable), refuse products or retailers the business does not
  have, refuse a page loaded before another save (`stale pricing revision`, even when both
  chose the same identifier), and record an audit row with the actor, reason and, on
  activation, the version it replaced. Activation recalculates the operator's preview
  from the stored version and is refused if the total differs.
- **Bundling.** The console imports the platform calculator from `src/`, so its Turbopack
  root is the repository and `zod` resolves to the console's own dependency (the console
  is built with only `web/` installed, as CI does).

Evidence:

- `verify-pricing.sql`: no grant, short reason, no identity, unknown product, unknown
  retailer, stale revision (including the same identifier), paused; save, retry and one
  audit row; activation without grant, stale, retry and one audit row naming the replaced
  version; a backdated version refused; a revoked grant refused; service-only access.
- Browser acceptance: the first version built from empty, a draft preview (10 tees,
  retail: 241.50 incl. 10.00 freight and 15% tax), save, a server-checked preview of the
  saved version (10 caps, tax-exempt retailer: 135.00), activation; a stale save refused
  with its draft kept; a signed-out request sent to sign in and a cross-site request
  refused; another business's product and retailer never shown.

Limits:

- The workbook import preview (`previewPriceImport`) is not in the console yet.
- Preview uses a hypothetical order, not a stored dispatch. Drafting real parts from the
  console, and approve → print, are step 4b.
- Reasoned per-invoice overrides (price or freight) are not in the console yet.

## 17 October: approve the exact invoice part, then print it (step 4b)

An invoice part drafted from a dispatch (0028) is approved, issued and printed from its
invoice page.

- **What the page shows.** The part's order reference and letter, shipment, pricing
  version and date basis, each line's price explanation, freight with its source, tax and
  due date, all from the immutable snapshot. The summary shows the part's own due date.
- **Approve and issue** (`operator_approve_invoice_part`, 0034). The page carries the
  digest of the snapshot it showed (`invoice_action_snapshot_digest`). In one transaction
  the database checks the operator's `controller.issue_invoice` grant (never seeded: a
  business turns issuing on deliberately) and pause, refuses anything but a draft
  dispatch part and any snapshot other than the one shown, prepares a bound action for
  exactly that snapshot, records the approval with the operator and an optional note,
  claims it and issues through `issue_bound_invoice` (authority, policy caps and the
  subject re-checked; ledger posted), then confirms the action with
  `delivery: not_confirmed`. Any refusal leaves no approval, action or issued invoice.
- **Print.** `/invoices/:id/print` renders the stored document, naming the business and
  retailer from their records; it refuses a draft. Opening it records nothing. The
  operator records **printed** or **printing failed** (with a note) against the stored
  document's digest (`operator_record_invoice_print`, `invoices.record_print` grant,
  seeded at boot). Outcomes are append-only; the latest is current and all are history.

Evidence:

- `verify-pricing.sql`: issuing off without the grant; a stale view, a legacy invoice, no
  identity and pause refused; part A issued with an operator approval, a confirmed action
  bound to the exact snapshot, one confirmed attempt with delivery not claimed, a ledger
  posting and one audit row; a second approval refused; a policy cap below part B refuses
  it and leaves nothing; print refused without grant, before issue, for another document,
  without a note when failed, or with an unknown outcome; failed then printed both kept
  and audited; outcomes append-only; service-only access.
- Browser acceptance drafts a real part through `draft_dispatch_invoice` (priced by the
  version the pricing journey activated: 10 tees, 241.50, due 2026-11-20), refuses to
  print the draft, approves and issues it, refuses a second approval from a page loaded
  before it, opens the printable invoice (order #5001, both parties, total, due date),
  then records a failed print without and with a note, and a successful print.

Limits:

- Parts are not drafted from the console or automatically yet: the Controller still
  drafts the legacy whole-order invoice on wholesale fulfillments, which blocks parts for
  that order (#28). Switching the Controller to dispatch parts is step 4c.
- Issuing still enqueues the legacy Stripe outbox row, marked failed as needing separate
  provider authorization; nothing is sent to Stripe or the retailer.
- Email delivery, payment instructions on the document and business branding are not
  built; the document names the business by its display name only.

