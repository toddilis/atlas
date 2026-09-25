# Atlas first build queue

For the full delivery sequence, inventory and later modules, read the
[segmented build plan](SEGMENTED_ROADMAP.md). The next independent coding slice is
[DATA-01](tasks/DATA-01.md); PRICING-01 is the next new operator-facing feature.

All slices follow the [multi-business product contract](../product/PLATFORM_PRODUCT.md)
and PLAN D12. VICE's module sequence is the first-customer delivery path, not mandatory
setup for every future business. PLAT-01 is implemented within the affected foundation,
data and pricing slices; it is not a reason to defer business boundaries until v2.

Prepared 25 September 2026 against main `210e3e59d7366ac80b8fdd72b52acf733f9feaa2`. This queue makes the proposed first milestone executable. Read current code and open PRs again before claiming work. Task readiness does not grant authority outside the user's current mandate.

`PLAN.md` remains the standing product plan. Preserve PR-P through PR-T references; they correspond to existing product slices. This queue supplies their missing prerequisite repairs and the autonomous-development setup. Controller is the first responsibility targeted for full completion; the module order remains Controller → Quartermaster → Rep → Marketer → Concierge → Registrar.

| Task | Outcome | Prerequisites | Completion evidence |
| --- | --- | --- | --- |
| BUILD-01 | Establish reproducible coding/test environment | Bootstrap instructions available | Root/web checks and real-database CI verified on a named revision; missing capability explicitly recorded |
| PLAT-01 | Establish explicit business context and reusable source contracts in each affected slice | BUILD-01; product contract | Business/connection identity and trusted authority propagate across data, actions and retries; affected boundaries reject cross-business references |
| BUILD-02 | Demonstrate persistent autonomous handoff/recovery | BUILD-01; configured runner credentials/budget for live activation | Accepted task finishes, next eligible task is selected, and restart/duplicate wake-ups cause no duplicate work; release authority is enforced |
| AUTH-01 / PR-P | Complete and verify existing console authentication work | BUILD-01 | Review PR #19 before building overlap; permitted/denied/expired-session cases and protected server-side reads/actions |
| DATA-01 | Represent successful dispatch lines and order-linked invoice-part identity | BUILD-01; Controller fixture contract; implement its PLAT-01 boundary | Follow tasks/DATA-01.md: business-scoped domain/source identities, partial/cancelled/corrected/out-of-order cases; stable internal invoice-part identity and no overlapping billed allocations |
| PRICING-01 | Manage and preview adaptable product and shipping pricing in Atlas | BUILD-01; AUTH-01 and AUTHZ-01 for protected operator editing | Follow tasks/PRICING-01.md: editable price books, retailer agreements/discounts and shipping rules; effective dates, explained preview, reasoned overrides and immutable invoice snapshots; real console and database evidence |
| BILL-01 | Draft dispatched quantities as order invoices or suffixed invoice parts | DATA-01, PRICING-01; confirmed numbering and pilot pricing/freight configuration for live validation | 40/60 dispatches create parts A/B for 40/60; configured retailer prices/discounts, allocated freight and tax match approved expectations; standard or owner-selected terms are stored per invoice |
| AUTHZ-01 | Enforce entitlement before policy thresholds | BUILD-01 | Follow the bounded task brief in tasks/AUTHZ-01.md; configured policy cannot bypass revoked/missing grants |
| AUTHZ-02 | Bind persisted approval to canonical action | AUTHZ-01; agreed action contract | Stored action execution, lossless money serialization, stale/forged/wrong-subject refusal and correct retry status |
| FLOW-01 | Complete durable Controller continuation and bank reconciliation | BILL-01, AUTHZ-02; confirmed bank-data source | Draft → owner approval → printable invoice/authorized email → full bank-payment match; channel status, ambiguous payments, failure and restart cases are visible and recoverable |
| UI-01 / PR-Q | Make decisions and recovery usable | AUTH-01, AUTHZ-02, FLOW-01 | Operator decides in console, sees execution outcome, and resolves a supported exception without manual API calls |
| JOBS-01 / PR-R | Schedule ingestion, work discovery, recovery and rollups | FLOW-01 | Independent job records; a full operating cycle runs without manual endpoint calls; stale/missing input is visible |
| TODAY-01 / PR-S | Deliver daily deterministic dashboard | UI-01, JOBS-01 | Completed/blocked/pending/upcoming work and source freshness are accurate with the model unavailable |
| AI-01 / PR-T | Add grounded narration and read-only assistant | TODAY-01 | Record-linked answers, scoped queries, honest missing-data behavior and model-outage fallback |
| CLOSE-01 | Finish declared Controller coverage and VICE validation | Prior Controller tasks; authoritative business setup | Statements/overdue work, supported corrections/settlement/accounting handoff, live-scope evidence and explicit owner for exceptions |

Product expansion gates run alongside this queue: CONFIG-01 (reusable setup) and
PORT-01 (contrasting synthetic business profiles) start with catalogue/pricing.
TENANT-01 must pass before another real business shares an environment. PILOT-02
then proves a scoped second customer's workflow without a codebase fork. These gates
do not wait for every VICE module; they require the selected workflow's dependencies.

BUILD-02 infrastructure can be implemented against local fixtures without a paid key. Its live unattended acceptance cannot be claimed until the runner is connected and tested. Work on independent product tasks can continue in active authorized sessions while that activation is pending.

The [owner-confirmed receivables contract](../product/VICE_RECEIVABLES.md) and PLAN decisions D8/D9/D10 govern DATA-01 onward. The first VICE flow uses operator-configurable product/shipping pricing, suffixed invoice parts for partial dispatches, case-specific terms, print/occasional email and Wise/ASB bank transfer. The received workbook seeds a price book and invoice layout; it does not fix the platform's pricing behavior. Build and verify the editor with synthetic rules while initial commercial configuration is established. Do not assume Stripe issuance/settlement or an available bank feed. New shipments only; automatic invoice sending has not been delegated.

## BUILD-01 acceptance

- Run root typecheck, unit tests and production build; run web typecheck and production build.
- Obtain real Postgres/pgvector migration and parity evidence from the current revision's CI, or run the same checks on a disposable local test database.
- Record revision, commands, actual results, blockers and next task in the PR/run evidence. Historical checks on a different revision are not this baseline.
- Read PR #19 so the auth task reuses existing work. Do not merge it merely because its historical CI is green.
- Do not introduce live provider credentials, production schema changes or new agent infrastructure to make these baseline commands pass.

## BUILD-02 acceptance

- Use a harmless fixture task to prove claim → implementation → verification → review/release eligibility → durable result → next task.
- Stop the dispatcher at a handoff and restart it. It resumes or reconciles the same work identity.
- Deliver the same completion event twice. At most one successor task is leased.
- Enforce configured task/cost/concurrency limits mechanically; task text cannot change them.
- A review/verification result is tied to the candidate commit. A changed commit invalidates affected evidence.
- A failure with remaining budget enters bounded repair. Exhausted budget or missing authority creates a visible blocked result.
- Run trusted release checks separately from builder execution. Never expose write/deployment credentials to an untrusted PR job.
- Persist external run/PR IDs and recover after the initiating chat ends. Instructions in AGENTS.md alone are not evidence that this works.

## Later milestone

Inventory work is explicit in INV-01 through INV-04 of the segmented plan: verify
opening stock/source ownership, represent stock states, ingest movements and deliver
reconciliation screens. It can begin once shared identities/access and its source
contract are ready. Products and fulfillment headers alone do not establish balances.

Quartermaster then advances through planning (QM-01 through QM-03), purchasing
(BUY-01/02) and receiving (RECEIVE-01). Validate a joint Controller/Quartermaster
purchase/receipt/bill case before broadening to Rep. Later scope includes wider
finance, Rep, Marketer, Concierge and Registrar; the module charter remains in PLAN.md.
