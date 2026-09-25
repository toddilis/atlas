# Atlas segmented build plan

Prepared 25 September 2026. This is the delivery view of [PLAN.md](../../PLAN.md),
with the first milestones executed through [BUILD_QUEUE.md](BUILD_QUEUE.md).
These segment numbers do not renumber the historical PR phases in PLAN.md.
Later capabilities are planned scope, not implemented features or delegated authority.

## What happens next

The next independent coding slice is [DATA-01](tasks/DATA-01.md): preserve actual
dispatched lines and quantities, so shipments of 40 and 60 cannot each invoice the
original 100-unit order. It is ready for synthetic implementation after BUILD-01;
final invoice numbering is a later configuration dependency.

Alongside that work, finish review/integration of the existing authentication and
permission changes, then bind approvals to the exact stored action in AUTHZ-02.
The next new operator-facing deliverable is [PRICING-01](tasks/PRICING-01.md): a usable
product, retailer and shipping pricing editor with a calculation preview.

The first business milestone remains: a new Shopify dispatch becomes an accurately
priced invoice, Todd approves it, the printable/selected email outcome is recorded,
and a Wise/ASB bank receipt reconciles or becomes a visible exception. This includes
the operator screen and recovery after interruption.

## Verified starting position

At the start of this update, these PRs were open, draft and unmerged, with no submitted
GitHub reviews. Their inspected workflow runs passed. CI success does not establish
independent review, deployment or a complete VICE workflow.

| Work | Inspected candidate | Evidence / remaining gate |
| --- | --- | --- |
| Console authentication, PR #19 | `2d6544d027bcafc47afe98927ba9691f7b85f17e` | [CI 32784903761](https://github.com/toddilis/atlas/actions/runs/32784903761) passed; permitted, denied and expired-session browser journeys remain |
| Setup, contracts and pricing plan, PR #20 | `3573017f88491b45df2cdea2d58cb17c389595ff` | [CI 36116004523](https://github.com/toddilis/atlas/actions/runs/36116004523) passed; pricing is a contract, not an implemented editor |
| Build coordinator fixture, PR #21 | `e56cdc50075931b8145a5a0edcb1d7a1bd3693d6` | [CI 36100422542](https://github.com/toddilis/atlas/actions/runs/36100422542) passed; real persistent runner/provider and chat-end/restart proof remain |
| Invocation permission fix, PR #22 | `947fd3709d3bb32342e9891a121467484dfdd0b7` | [CI 36102090802](https://github.com/toddilis/atlas/actions/runs/36102090802) passed; stored approval binding remains AUTHZ-02 |

Existing main contains event processing, basic pricing, billing/ledger code and a
read-only console. Those components do not yet demonstrate the owner-confirmed
bank-transfer and partial-invoice journey. The reviewed Shopify sync imports product
identities, orders and fulfillment headers; that is not a verified inventory balance
feed. Inventory requires explicit quantities, sources and reconciliation.

## Delivery segments

| Segment | What the operator receives | Depends on | Exit demonstration |
| --- | --- | --- | --- |
| 1. Shared foundation | Secure access, permissions, reliable imports, audit history, protected actions and recoverable jobs | Existing code and BUILD-01 | Allowed/denied/expired access behaves correctly; changed approvals cannot execute; repeated/interrupted work converges |
| 2. Catalogue and commercial setup | Product/variant catalogue, retailer accounts, editable product/discount/shipping rules and effective dates | Segment 1 gates for protected editing | Change retailer pricing/shipping, preview the result and activate a version without changing historical invoices |
| 3. Controller: new receivables | Dispatch-based invoice parts, selected terms, approval, print/email and bank reconciliation | Segments 1–2; DATA-01; pilot configuration | A new-shipment-to-paid journey, including a partial dispatch and a recoverable exception |
| 4. Daily operations | Today screen, approvals, exceptions, source freshness, scheduled work and grounded assistant | Segment 3 events and shared console | A controlled operating cycle runs without manual endpoint calls; the operator resolves an exception in the console |
| 5. Inventory | Stock by SKU/variant and location, available/reserved/incoming quantities, movement history and reconciliation | Shared identities/access; confirmed inventory sources | Opening balance plus movements ties to closing stock; duplicates, transfers, returns and stocktakes preserve correct balances |
| 6. Quartermaster: planning | Low-stock/overstock view, demand and lead-time assumptions, replenishment and transfer proposals | Proven segment 5 balances; supplier/lead-time data; Controller operating loop | Each recommendation explains stock, demand, inbound supply, timing and quantity; stale/missing data blocks unsupported recommendations |
| 7. Quartermaster: buying and receiving | Supplier catalogue, POs, approval, supplier acknowledgement, inbound tracking and goods receipt | Segment 6; purchasing policy and supplier channel | Approve a PO, record the supplier outcome and receive it in parts; shortages/damage and retries reconcile without double receipts |
| 8. Controller: wider finance | Consignment settlement, DTC reconciliation, supplier bills/AP, purchase matching, costs and supported corrections | Receivables and inventory; receipts for AP matching | Inventory/receipt, invoice and ledger evidence reconcile; differences have an owner and resolution path |
| 9. Rep: wholesale accounts | Account history, reorder opportunities, dormancy alerts, onboarding and offer proposals | Stable Quartermaster; enough account activity | A proposed reorder/offer uses current stock, approved pricing and account/payment context, with communication recorded |
| 10. Marketer: growth | Campaign/content proposals, audience selection, stock-aware promotions and measured results | Rep/Quartermaster context; selected marketing channels | An approved campaign reaches its selected test audience with correct price/stock constraints and attributable results |
| 11. Concierge: customer support | Order/payment/shipping answers, inbox triage and return/refund proposals | Reliable business records; support channel | A case resolves from traceable records; an authorized return/refund follows the financial and stock correction paths |
| 12. Registrar: back office | Reconciled reporting packs, filing documents, renewal calendar and compliance reminders | Controller close/reporting data; applicable obligations confirmed | A reporting pack traces to reconciled records; an obligation has an owner, evidence and a deadline |

Segments 9–12 remain trigger-based: enough relevant work and trustworthy data must
exist before each begins. External channels are selected during setup; the plan does
not assume new accounts, access or spending. Quartermaster remains the second business
module. Inventory is its data/operator foundation, delivered before planning and buying.

## Work packages

### 1. Shared foundation

- BUILD-01: retain the verified environment and commit-specific checks.
- AUTH-01 / PR-P: review/reuse PR #19 and verify real protected browser journeys.
- AUTHZ-01 / AUTHZ-02: integrate the invocation grant fix, then bind approval to stored
  subject, material parameters, authority, expiry and execution/recovery state.
- DATA-01: reliable dispatch-line identity, eligibility and allocation contract.
- OPS-01: deployment readiness, backup/restore rehearsal, monitoring and runbooks for
  the pilot environment before live use. Deployment files alone do not pass it.

### 2. Catalogue and commercial setup

- CATALOG-01: product/variant identifiers, units, retailer mappings, missing/duplicate
  SKU handling and controlled spreadsheet import. Share these identities with inventory.
- PRICING-01A: persisted/versioned product, discount and shipping rules, deterministic
  resolver and explained preview. These are implementation slices of PRICING-01.
- PRICING-01B: authenticated editor, import/difference preview, activation, effective
  dates, manual overrides and change history. No code edits for commercial changes.
- SETUP-01: capture terms, currency/tax/rounding setup, invoice numbering, recipient
  preferences and payment instructions through validated configuration.

### 3. Controller: new receivables

- BILL-01: invoice successful dispatched quantities; stable A/B parts, freight
  allocation and immutable pricing/terms snapshots.
- FLOW-01A: approve the exact draft, produce its print document or authorized email,
  and distinguish generated, packed, requested, confirmed and failed outcomes.
- FLOW-01B: ingest the selected Wise/ASB transaction input, deduplicate and match using
  sufficient evidence; expose ambiguous, partial, excess and unmatched receipts.
- UI-01 / CLOSE-01: complete invoice/approval/exception screens and validate the declared
  new-shipment scope. Existing unpaid balances remain excluded from this pilot.

### 4. Daily operations

- JOBS-01 / PR-R: schedule sync, work discovery, expiry and recovery with durable records.
- TODAY-01 / PR-S: deterministic daily overview, balances, decisions, failures and stale
  sources. Each number links to underlying records.
- AI-01 / PR-T: read-only assistant and narration over those records. The operating
  workflow and calculations continue when the model is unavailable.

### 5. Inventory foundation

- INV-01: identify the authoritative count/movement source for each location and SKU;
  import an opening snapshot with its timestamp, units and reconciliation evidence.
- INV-02: model on-hand, reserved, available, incoming, in-transit, damaged/quarantined
  and consigned stock without overlapping counts. Define availability explicitly.
- INV-03: ingest sales/dispatches, receipts, returns, transfers and reasoned adjustments.
  Reconcile snapshot feeds and event feeds without counting a movement twice.
- INV-04: stock screen, movement drill-down, stocktakes, mismatch resolution and source
  freshness. A missing baseline is unknown stock, not zero stock.

Transfers distinguish departure, in-transit and receipt at the destination. Consignment
tracks physical location and ownership separately. A reservation and its dispatch must
not both reduce on-hand stock. A physical return and refund are separate linked events.

Inventory discovery and source-contract work may start alongside Controller once shared
SKU/order/location identities are stable. A read-only inventory slice can proceed when
its source/auth prerequisites pass. Quartermaster recommendations wait for reconciled
balances; inventory write-back needs a source-of-truth and conflict policy.

### 6. Quartermaster planning

- QM-01: supplier-product mapping, lead times, minimum order quantities, pack sizes,
  purchase currency/cost, target coverage and safety-stock policy.
- QM-02: explainable demand and replenishment calculations including reservations and
  confirmed inbound stock; sparse history and stockout periods remain visible.
- QM-03: ranked purchase/transfer proposals with assumptions, expected stockout dates
  and spend. Recalculate stale proposals before approval.

Demand estimates are inputs with visible uncertainty. Deterministic rules own quantities,
pack rounding, thresholds and spending limits. Recommendations do not place orders.

### 7. Quartermaster purchasing and receiving

- BUY-01: versioned PO proposal and approval of its supplier, lines, cost and terms.
- BUY-02: selected authorized supplier channel, acknowledgement/status and reconciliation
  of an uncertain send before any resend.
- RECEIVE-01: due shipments, partial/short/damaged receipts against PO lines, inventory
  updates exactly once and retained discrepancy cases.
- QM-FIN-01: publish receipt/cost events for Controller. Demonstrate PO -> part receipt
  -> remaining receipt -> supplier-bill match across the two modules.

### 8. Wider finance

- FIN-01: supported credits, voids, disputes, returns/refunds and statement corrections.
- FIN-02: consignment sales/returns/settlement and DTC payment/fee reconciliation.
- FIN-03: supplier bill capture, PO/receipt/bill matching, payable due dates and landed
  cost allocation. Bill approval is separate from payment execution.
- FIN-04: reconciled period close and accounting handoff; inter-company flows only when
  actual entities and rules make them necessary.

Essential receivables corrections/statements belong in segment 3/CLOSE-01. This segment
expands coverage rather than postponing safe invoice operation.

### 9–12. Later business modules

- REP-01/02: account-health/read views, then approved reorder outreach and offer workflows.
- MKT-01/02: campaign planning with stock/pricing constraints, then approved publishing
  and outcome measurement through selected channels.
- CX-01/02: source-grounded support triage/answers, then approved transactional resolutions.
- REG-01/02: reporting/document preparation, then obligations/renewal tracking. Filing
  or submission authority is separately configured and must not be inferred.

Add a bounded task brief for each package before implementation. Split future modules
into reviewable PRs with concrete outcomes. Manufacturing/BOM/work-in-progress tooling
remains inside Quartermaster planning until actual production complexity warrants a
separate scope; it is not part of the first inventory/reordering release.

## Two continuing tracks

**Development automation:** BUILD-02's tested fixture must become a real persistent
dispatcher with provider jobs, review evidence, cost/concurrency/retry limits and
delegated merge/release policy. Its completion gate is work continuing after the chat
ends and recovering from interruption. It can advance alongside product work; it is
not active and is not required for ordinary authorized coding sessions.

**Shared platform:** every segment reuses identities, permissions, audit, approvals,
events, durable work and the console. Add memory over reliable source records. Any
increase in authority is explicit and action-specific. Extract the common module
contract when Quartermaster supplies the second real consumer. Multi-business tenancy
and wider roles come later, after VICE's workflows are proven.

## Dependencies and release standard

The first critical path is DATA-01 + PRICING-01 -> BILL-01, with AUTH-01/AUTHZ-02
protecting editing and approval -> FLOW-01/UI-01 -> JOBS-01/TODAY-01/CLOSE-01.
Inventory enables Quartermaster planning -> purchasing/receiving. Wider finance
consumes those records. Rep and later modules reuse that trusted context. Dependencies
govern delivery, not a requirement that all development happen serially.

Every delivered slice includes persisted data, protected actions, its operator screen,
empty/error/stale states, replay/restart behavior and a traceable outcome. Use application,
real database and browser acceptance where relevant. Independent review is required
for release. Unit-only success or a mock screen is not workflow completion.

Track: planned -> implemented -> verified on a named candidate -> reviewed -> deployed
to the named environment -> validated in the declared live scope. Set scope and required
inputs before each milestone. Calendar dates follow estimated work packages and known
integration access; this plan does not invent dates from an unestimated backlog.

## Business inputs, collected when needed

| Before | Needed from the business |
| --- | --- |
| First invoice pilot | Initial price/retailer/shipping rules, numbering/terms/tax/rounding configuration, bank-input sample, recipients and activation cutoff; template already received |
| Inventory reconciliation | Locations/ownership, where counts are maintained, a dated opening snapshot, units and treatment of reserved/damaged/consigned stock |
| Quartermaster proposals | Suppliers, product mapping, lead times, minimums/pack sizes, purchase costs, target coverage and approval/spend limits |
| Supplier ordering | Supplier communication route, receiving process, purchasing terms and authority |
| Later modules | Channel access, operating volume, business policies and success measures for that module |

The development process owns task breakdown, implementation, verification and routine
repair. The owner supplies business decisions and priority changes. Missing commercial
values are configuration inputs, not a reason to stop unrelated engineering work.
