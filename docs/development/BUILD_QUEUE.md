# Atlas first build queue

## Active coordination: 1–7 October 2026

This is the sole canonical queue. This section supersedes the dated status snapshots
below; those remain history, not current readiness evidence. Coordinator owns updates
to this file. Track owners send commit-bound handoffs rather than editing competing
queues. Observation date: 1 October 2026, Pacific/Auckland.

**Weekly acceptance:** a synthetic test-environment Controller journey from eligible
dispatch through configured pricing, stable invoice parts, exact-action owner approval
and printable output, with linked evidence, visible failed/unknown states and recovery.
Bank reconciliation and a complete exception-resolution UI are stretch work. This does
not close the wider FLOW-01/CLOSE-01 receivables milestone or weaken their acceptance.
Print generation proves an artifact exists, not packing, delivery or payment.

Authority here covers planning, inspection and reversible local integration checks.
No merge, deployment, paid activation, recurring build runner or live business action
is authorized by this queue. Previous dated approval text is not a new release mandate.

### Current repository evidence

GitHub main is `cbcb2e7620e73f1406bc8e31edb5b91687c866fb` (**M**). Fresh inspection
of its [CI run 36306722411](https://github.com/toddilis/atlas/actions/runs/36306722411)
shows successful root, console and real Postgres migration/parity jobs. This evidence
belongs to M, not future combined candidates. PRs #20, #22, #23 and #24 are merged;
ARCH-01 is no longer awaiting merge and DATA-01 is no longer the next unbuilt slice.

Accepted shared contract **C** is Controller v1 / architecture v0.2, foundation commit
`c816ac212c666f5e4e2f6799701e7bc9da963b20`, already contained in M. Executable source:
`src/platform/contracts/controller-v1.ts`; strict reader/version rules remain binding.
Existing entitlement and dispatch allocations are supplied by M, with merged heads
`947fd3709d3bb32342e9891a121467484dfdd0b7` and
`96bfa4e382326c2a580ead3a2d4fa72b5f1dc86d` respectively.

| Existing candidate | Exact head / original merge base with M | Observed evidence and remaining gate |
| --- | --- | --- |
| AUTH-01 [#19](https://github.com/toddilis/atlas/pull/19), `claude/lucid-gauss-p1mjpy` | `2d6544d027bcafc47afe98927ba9691f7b85f17e` / `210e3e59d7366ac80b8fdd72b52acf733f9feaa2` | Open draft; [32784903761](https://github.com/toddilis/atlas/actions/runs/32784903761) succeeded on the old base. Current-base browser/server acceptance pending. |
| AUTHZ-02 [#25](https://github.com/toddilis/atlas/pull/25), `codex/authz-02-bound-actions` | `f09d0a505c45d8b0cb7a9a44d7be3ee40c736d7b` / M | Open draft; [36309406695](https://github.com/toddilis/atlas/actions/runs/36309406695) FAILED root typecheck and generated database-type drift. Console job passed. SQL probes passing within a failed job do not establish the full gate. |
| BUILD-02 fixture [#21](https://github.com/toddilis/atlas/pull/21), `codex/build-02-fixture-coordinator` | `e56cdc50075931b8145a5a0edcb1d7a1bd3693d6` / `d7020433040cb4a5d93aaa14b9f3a38ddd9b814c` | Open draft; [36100422542](https://github.com/toddilis/atlas/actions/runs/36100422542) passed against historical base. Current integration and persistent runner acceptance pending. |
| BUILD-02 reviewer [#26](https://github.com/toddilis/atlas/pull/26), `codex/reviewer-integration` | `cd002654ba56b28f4dacbec629e2d10371eb126f` / M | Open draft; [36313734586](https://github.com/toddilis/atlas/actions/runs/36313734586) successful root, console and DB jobs. Reviewer activation and live trust proof absent; fixture runner is a separate deliverable. |

PR #2 is unrelated historical policy-agent work, remains open, and is excluded from
this week's integration. Remote branch inventory contained no new pricing or
event/evidence candidate at this inspection. A branch existing or a chat being active
is not verification. No accepted combined product candidate exists yet.

### Named owners, claims and candidates

Owner IDs identify the active local Codex tasks; their messages supply claims, while
repository/CI inspection supplies candidate evidence. All rows accept C. All new
product work starts from M unless an exact dependency below is stated. Isolated
checkouts are under `C:/Users/toddl/Documents/Codex/2026-10-01/` in the owner's task
directory; existing September worktrees were inspected without modification.

| Task / named owner | Branch / PR and starting commit | Dependencies / owned surfaces | Current candidate and next acceptance |
| --- | --- | --- | --- |
| Integration / `01a0f427-d5c8-7833-9232-4e60c8bce138` | `codex/integration-2026-10-01`, starts M; planning PR pending | Queue, PLAN/roadmap reconciliation, shared contract decisions, composition/evidence | Documentation working tree only; no product implementation or accepted combined candidate. Publish claims/order, inspect candidate drift and route conflicts. |
| AUTH-01 + AUTHZ-02 / `01a0f428-1f15-70f1-9ab4-1298b60b078c` | `codex/auth-oct01-completion`, starts #25 `f09d0a505c45d8b0cb7a9a44d7be3ee40c736d7b`; consumes #19 exact head above; existing #19/#25 reused | C + entitlement in M. `src/platform/control-plane/{approvals,bound-actions}.ts`, tools grants/registry/outbox, events/context, agent/registry, approval-routes, web auth; migrations 0022 and 0027 | Local combined `6e652bd799288437f52ce3822053620ae830e288` resolved from owner's checkout, not accepted/verified; edits in progress. Repair current CI and concurrent aggregate-limit race; prove stored intent, revocation/expiry/pause/restart and trusted server reads/actions. Disposable auth environment absent, browser gate blocked. |
| PRICING-01A/B, BILL-01, weekly FLOW-01A/UI subset / `01a0f428-d1c6-7553-8b9c-b1c23f18b78b` | `codex/pricing-billing-oct01`, starts M; PR pending | C + DATA-01 in M; protected editor waits AUTH acceptance; approval/print consumes AUTHZ/EVENT/EVIDENCE. `src/platform/pricing/*`, Controller draft_invoice/new billing/print files, pricing/invoice console and focused tests; 0023 and 0028 | No candidate yet; domain implementation claimed. Versioned explained pricing; stable 40/60 A/B allocations; immutable tax/freight/terms snapshots; authorized printable output. Do not edit AUTH's issue_invoice adapter without named handoff. |
| EVENT-01 + EVIDENCE-01 / `01a0f429-1266-71d3-bc08-0f8784cd425c` | `codex/event-evidence-oct01`, starts M, consumes #25 `f09d0a505c45d8b0cb7a9a44d7be3ee40c736d7b`; PR pending | C, existing DATA-01 boundaries, AUTH action/attempt API. New event publication/receipts/replay and evidence modules/read interface, focused tests; 0025–0026 | No candidate yet. Atomic SQL publication helper, receipt-owned projections and forward evidence triggers over AUTH records proposed; real DB tests pending. Does not own approval policy or invoice calculations. |
| BUILD-02 fixture + reviewer / `01a0f429-4e9c-7b61-93a6-71b7777164f0` | `codex/build-02-october-fixture-hardening`, starts #26 `cd002654ba56b28f4dacbec629e2d10371eb126f`, consumes #21 exact head above; [draft #27](https://github.com/toddilis/atlas/pull/27) | Independent of product critical path. `scripts/reviewer/**`, `scripts/build-loop/**`, automation tests/runbooks, review workflow; coordinator-reviewed CI/package wiring | Owner handed off `8c4732fcb1a58d5c7eac971ce74384d6dc36f8ea`, tree `b01f1533a8ab6ab5b16219d3120a48c04ebc9d64`; GitHub/independent review pending. Owner reports typecheck and 39 reviewer tests pass, fixture 10/19 with 9 host-resource failures. Production provider/store/scheduler still absent, not merely unconfigured credentials. |
| VERIFY-ARCH-01 / `01a0f429-7a47-7a32-bbbd-d1165e6fc18b` | Detached `atlas-review` at M, `auth-review` at #19 and `authz-review` at #25 under own task; no implementation PR | Exact candidate + C + dependency manifest; local reports/reproductions only | No combined verdict yet. Local Postgres/pgvector/Docker and disposable auth unavailable. Independent DB/API/browser gates pending; #25 aggregate-policy race routed to AUTH. Findings go to implementation owners, never self-fixed by verifier. |

Each owner must hand off the full starting and candidate SHAs, dependency SHAs, branch/PR,
contract delta, owned-file diff, migration IDs, command/results with artifact URLs,
unresolved findings and next eligible task. An intermediate local merge is not an accepted
candidate. A changed head/base/contract invalidates affected evidence. Before integration,
coordinator checks each exact diff against claims and records a composed tree/commit.

### Shared-file and migration leases

| Surface | Single change owner / reconciliation rule |
| --- | --- |
| `BUILD_QUEUE.md`, PLAN status and `SEGMENTED_ROADMAP.md` | Integration; preserve wider historical/product requirements, add dated corrections. |
| `src/platform/contracts/controller-v1.ts`, shared schemas/fixtures and architecture specs | Integration coordinates a concrete delta and consumers before one designated owner edits. Existing C remains accepted until a recorded version/compatibility decision. |
| Approval intent, attempts, `events/context.ts`, `tools/outbox.ts` | AUTH owns #25 changes. EVENT/EVIDENCE consumes these records; no second attempt/approval state machine. Proposed event hooks return to AUTH as narrow patches. |
| `src/agents/controller/tools/issue_invoice.ts` and tools index | AUTH preserves existing #25 adapter changes; Controller requests a named print-adapter seam before changes. No competing issue/approval path. |
| `src/api/server.ts`, worker/dispatch boot wiring | Coordinator serializes narrow AUTH, event and Controller patches; each track owns its separate route/module. No whole-file replacement. |
| `.github/workflows/atlas-ci.yml`, root package scripts | Automation prepares the sole combined diff; preserve main checks, #19 web auth tests, #25 DB probes and #26 read-only/docs-CI guarantees. Review policy required-job names must match. |
| `scripts/verify-migrations.sh` | Coordinator composes distinct named probe hooks from migration owners; no lost earlier probes. |
| `src/data/database.types.ts` | AUTH first repairs #25's generated drift; each schema owner regenerates its candidate, then coordinator regenerates once from the complete ordered disposable schema. Never hand-resolve competing generated blocks. |
| Migrations 0001–0021 | Merged, immutable. Forward migrations only. |
| `0022_bound_actions.sql` | AUTH existing candidate; pending/unmerged history, preserve ownership. |
| 0023 | Pricing reserved. |
| 0024 | Vacant/reserved; unpublished BILL work moves to 0028 because it calls EVENT helper. No filler migration needed. |
| 0025–0026 | EVENT/EVIDENCE reserved. May develop independently from missing lower numbers; final fresh DB applies all in numeric order. Any actual cross-track SQL dependency must be declared, not inferred from numbering. |
| 0027 | AUTH current-policy/concurrent aggregate-limit hardening, forward from 0022. |
| 0028 | BILL, after EVENT helper 0025, evidence 0026 and AUTH hardening 0027. |

Additional migration numbers require coordinator allocation before edits. These leases
are file ownership, not authority to change shared contracts or production data.

### Integration decisions and order

1. **Foundation already available:** M contains entitlement, dispatch allocation and C.
   Reuse these; do not rebuild DATA-01 or merge its old branch again.
2. **Independent foundation candidates:** AUTH completes #19/#25 and its browser gate;
   EVENT/EVIDENCE implements shared delivery/linkage; Controller develops pricing and
   snapshots against C. Missing auth setup does not stop deterministic pricing or DB work.
3. **Controller composition:** verified pricing + DATA-01 → BILL snapshots/40–60 parts.
   Integrate protected editing only after AUTH acceptance. Bind approved action to invoice
   revision, document content, exact total, terms and destination; consume AUTH attempts.
4. **Weekly FLOW/UI composition:** wire event/evidence hooks, owner decision, print adapter,
   visible pending/failed/unknown/generated state and recovery. Confirm only artifact
   generation; no Stripe issuance, email, bank or paid outcome is implied.
5. **Independent acceptance:** freeze a combined candidate SHA and dependency manifest,
   run required checks and the real DB/API/browser journey, route findings to owners,
   then reverify changed candidates. Release remains held for separately established authority.

Automation #21/#26 composes separately and cannot block ordinary product development.
Its trust/activation gate is separate from Controller acceptance.

Coordination decisions: canonical `company_id` crosses shared contracts; internal
`org_id`/`businessId` needs an explicit trusted mapping. Calculation snapshots may be
Controller-owned internals, but must retain config/source versions and map to existing
strict ActionV1/document/total fields. Material invoice or terms changes require a new
revision and approval. Evidence records reference AUTH-owned actions/attempts; local
transition plus publication must be atomic. Missing metrics remain unknown. No automatic
memory promotion is in scope. Record any shared-schema amendment before writers emit it.

### Acceptance evidence still required

| Gate | Required observed result |
| --- | --- |
| AUTH | Allowed, denied and expired sessions in real browser; direct protected reads/actions refused; service-role access remains behind server checks. Forged, edited, expired, revoked and cross-business intent refused. Pause and revoked grants survive restart. |
| Pricing/BILL | Two synthetic retailers, effective-boundary rule change, explained price/freight/tax/terms; wholesale and supported no-shipping service preview; 100-unit order split 40/60 gives stable A/B for 40/60 with no repeated quantity/freight allocation. Repricing never mutates historical snapshots. |
| Recovery/isolation | Real DB concurrent claims, duplicate events and crashes before/after effect; known no-effect retry reuses identity, unknown stays owned/unresolved until reconciled. Replay never dispatches tools; A cannot access B's records or credentials. |
| Evidence/operator | Observation → immutable decision snapshot → exact approval/action → attempt → generated artifact/outcome linkage. Visible missing/stale/failure/unknown reasons and bounded recovery path; model unavailability does not break deterministic workflow. |
| Combined candidate | Root typecheck/tests/build, console tests/typecheck/build, fresh Postgres+pgvector migrations/probes/type drift/parity, authenticated browser edit/preview/activate and approve/print journey, independent verdict bound to same SHA. |

Environment blocker: AUTH reports no disposable Supabase Auth endpoint/anon and service
keys, synthetic organization, allowed/denied users or test database configuration.
Do not use live credentials. Browser acceptance remains blocked until a disposable
environment is supplied or locally provisioned and verified; no fixture substitution.

Planning checkpoints (targets, not completion promises): 1 October reconcile/lease;
2–3 October foundation and first domain candidates; 4–5 October BILL/print composition;
6 October freeze and independent journey; 7 October repair/reverify and report readiness.
If dependencies slip, report the demonstrated subset and blocked gate rather than widen
scope or mark the week complete. Bank/full exception UI remain stretch.

### Coordinator integration checks — initial pass

Local isolated clone at `you-are-the-integration-coordinator-for/atlas`, branch
`codex/integration-2026-10-01`, starting M. Existing September checkouts untouched.
`git merge-tree --write-tree` checked exact fetched heads without changing a worktree:

- M + #19: README.md content conflict; auth owner must preserve current product docs.
- M + #25: clean textual merge; current CI still fails, so not integration-ready.
- M + #21: atlas-ci.yml and package.json conflicts; automation owns reconciliation.
- M + #26: clean, tree `b97df58449efe270c505ca8646d60401ddc46107`.
- #25 + #26: clean textual merge, tree `8b7376d611e6465918ae0da98064ad9414ce1861`;
  this does not prove CI wiring semantics or product acceptance.

No code was changed or remotely merged by these checks. No combined journey passed.

Subsequent same-day coordination decisions (implementation/evidence pending):

- Controller has the sole bounded lease to add strict `controller.invoice.drafted`
  v1 payload/reader registration and fixtures in controller-v1.ts. Reuse MoneyV1 and
  reference validation, including company/revision/subject checks; scale 2 is a synthetic
  configuration, not a new shared invariant. Reader-first rollout before BILL writers.
- EVENT owns strict native adapter registrations `platform.action.state_recorded`,
  `platform.attempt.state_recorded`, `platform.approval.state_recorded`, carried by
  `platform.envelope.v1` in existing event_log. They describe native AUTH records,
  not silently relabelled ActionV1/ExecutionV1. Preserve unknown and historical adoption.
- EVIDENCE proposes 0026 triggers over AUTH records so history and event publication
  share the parent transition transaction; no changes to 0022. Verify tenant linkage,
  no-op deduplication and rollback on failed publication. No approval/attempt duplication.
- BILL moved to 0028 so publish_platform_event and AUTH hardening exist first.
- Host paging-file exhaustion was reported by automation. Local heavyweight builds
  are serialized by coordinator; prefer exact-candidate CI for full builds/database
  checks. Resource failures are recorded, not counted as passes or code failures.

---

## Standing backlog and historical snapshots

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
