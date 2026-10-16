# Atlas first build queue

For the full delivery sequence, inventory and later modules, read the
[segmented build plan](SEGMENTED_ROADMAP.md). DATA-01 and AUTHZ-01 have merged.
[PRICING-01](tasks/PRICING-01.md) is the next new operator-facing feature; protected
editing requires AUTH-01 browser acceptance. See the current integration status below.

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


## Architecture foundation and parallel adoption — 2026-09-27

This remains the sole live queue. Foundation [track briefs](../architecture/PARALLEL_TRACK_BRIEFS.md)
extend existing tasks without replacing programme priorities. Snapshot readiness is not
a claim that PRs merged. Check current prerequisites and PR heads before taking a lease.
Reference contract version: Controller v1, exported in architecture pack v0.2.

| ID / owner track | Status at foundation revision | Dependencies / merge constraint | Expected contracts or surfaces | Verification |
| --- | --- | --- | --- | --- |
| ARCH-01 / Integration | Reference implementation; checks recorded in foundation validation report | Bootstrap PR #20 baseline; merge before dependent contract consumers | Foundation docs, contracts/controller-v1, fixtures, queue | Schema/fixture tests, documentation links, compatibility review |
| AUTHZ-02 / Authorization | Planned runtime adoption; existing task retained | AUTHZ-01 PR #22 + ARCH-01 | Approval/action binding, trusted tool/API/DB boundary | Edited/stale/revoked/wrong-business refusal and durable attempt handoff |
| EVENT-01 / Platform events | Planned | ARCH-01; coordinate DATA-01 PR #23 surfaces | Envelope adapters, event log, outbox, receipts/replay | Real DB atomicity, duplicates, ordering, crash and replay cases |
| EVIDENCE-01 / Evidence | Planned; fixture work may run in parallel | ARCH-01; integrate with AUTHZ-02, EVENT-01 and FLOW-01 | Decision/attempt/outcome persistence and read models | Immutable snapshots, explicit unknowns, complete linkage |
| UI-01 / Operator | Existing task; fixture prototype can start after ARCH-01 | Retain AUTH-01/AUTHZ-02/FLOW-01 integration gates | Approvals, execution and exception views | Real authenticated browser recovery journey |
| VERIFY-ARCH-01 / Independent verification | Pending candidates | Exact candidate revisions from affected tasks | Read-only review, journey evidence | Full failure/tenant/recovery gate in adoption gaps |

FLOW-01 additionally consumes EVENT-01 and EVIDENCE-01 for production readiness; their
shared contracts allow concurrent implementation, with the integrated journey verified
after all are available. This does not make the evidence track depend on completed FLOW-01.
DATA-01 and PRICING-01 retain their existing acceptance and business prerequisites.

Each claimed item must add: named owner, branch/PR, starting commit, accepted contract
commit/version, expected files, dependency commit(s), status, merge dependency, candidate
commit, verification result and next eligible task. A new candidate invalidates affected
review evidence. Unclaimed planned rows have role owners, not an implied active worker.
Use isolated branches. Do not independently modify another track's contracts or reorder
the programme. Missing live configuration does not block synthetic/read-only work.

Open PR inventory checked during this revision: #19 authentication, #20 bootstrap,
#21 fixture build coordinator (based on bootstrap), #22 entitlement, #23 dispatch data
(based on entitlement). No merge/completion is implied. Recheck before implementation.

## Current integration status — 27 September 2026

This section supersedes historical readiness labels above. User review was accepted in
the task with "Reviewed, green lit"; passing candidate checks remain mandatory.

| Task | Current evidence and state | Next boundary |
| --- | --- | --- |
| Bootstrap / PR #20 | Merged as `3ad3834`; approved head `3d0e3f6` had passing CI | Foundation dependency satisfied |
| AUTHZ-01 / PR #22 | Merged as `b7074fe`; approved head `947fd37` had passing application/database/console checks | AUTHZ-02 still required for stored approval execution |
| DATA-01 / PR #23 | Merged as `b0cec87`; final head `96bfa4e` passed run `36306182729`, including real DB probes, type generation and parity | PRICING-01 then BILL-01; no live billing activated |
| ARCH-01 / PR #24 | User review accepted; combined implementation `901dc91` passed CI run `36306553820` (136 tests, root/console builds and real DB checks) | Final evidence-only revision must pass CI; PR records merge state |
| AUTH-01 / PR #19 | Still open; historical CI does not establish permitted/denied/expired-session browser acceptance | Verify against a disposable configured auth environment before integration |
| BUILD-02 / PR #21 | Separate fixture coordinator remains open | No unattended/live runner activation implied |

Independent ready work after ARCH-01: AUTHZ-02, EVENT-01 and EVIDENCE-01 with their
declared dependencies. Pricing domain/fixture work can proceed while AUTH-01 acceptance
is completed. Preserve BILL-01/FLOW-01 gates and live-configuration requirements.
