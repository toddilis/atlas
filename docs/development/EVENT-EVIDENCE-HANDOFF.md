# EVENT-01 / EVIDENCE-01 — 1–7 October 2026

Owner: event/evidence track. Branch `codex/event-evidence-oct01`, isolated checkout.
Starting main: `cbcb2e7620e73f1406bc8e31edb5b91687c866fb`. Architecture v0.2 /
Controller v1: `c816ac212c666f5e4e2f6799701e7bc9da963b20`. DATA-01 is included in
that main. Initial AUTH dependency: `f09d0a505c45d8b0cb7a9a44d7be3ee40c736d7b`
(PR #25); final acceptance must pin the repaired AUTH candidate.

Coordinator reserved migrations 0025–0026, new event/evidence modules and tests.
Approved shared patches: appended migration probe, one concurrency CI step, two-line
server registration, legacy replay context and agent dispatch suppression. AUTH owns
context.ts, authority, approved_actions and action_attempts. Controller owns domain
invoice facts, calculations, 0023–0024 and forward domain integration. Queue/contract
amendments and final type regeneration belong to integration. Automation owns final CI.

## Consumer contract

`publish_platform_event(p_org_id uuid, p_envelope jsonb, p_source_key text,
p_consumers text[] default '{}') returns uuid` is callable **inside the domain SQL
transaction**. It returns the existing spine UUID for an identical duplicate. Envelope
`event_id` is a stable opaque identity, not necessarily the spine UUID. Reuse all
envelope fields on retry, including observation time. Scope provider deduplication by
business, connection, event type and source key. Reusing identity with changed content
is an exception. Causation must identify an existing event in the same company.

Canonical `EventEnvelopeV1` is stored unchanged inside `event_log`, transport type
`platform.envelope.v1`; legacy domain handlers have no subscription to this namespace.
`platform_events` indexes the immutable envelope. Publication creates specified
consumer receipts atomically. Unsupported types/versions remain durable/quarantined.
An empty consumer list deliberately produces no new work. The new worker is opt-in;
no scheduler or production processing is activated by this change.

`claim_event_receipt` leases one company/consumer/generation delivery with a fencing
token. `apply_event_projection` derives the version and payload from the stored event,
then commits the generic read model and receipt in one transaction. There is no
arbitrary callback and no business-tool dispatch. Expired claims can be recovered
because this path has only transactional read-model effects. A committed receipt is
idempotent. Stale workers cannot commit. Missing versions retry with bounded backoff,
conflicting same-version identities quarantine, older versions cannot overwrite newer
ones. Ten attempts exhaust into quarantine, including crash-lost final claims.
`resume_event_receipt` requires actor/reason and appends audit evidence.

`enqueue_event_replay` requires a distinct named generation. Rebuilds do not overwrite
the live projection. The TS worker always uses the shared side-effect-disabled context.
Legacy `replay({fromSeq})` now uses that context too, skips agent callbacks (including
Controller's direct draft handler), and retains ordinary read projectors. Ordinary
legacy retry remains existing behavior and is not certified as receipt-based processing.

## Evidence integration

Use server-only `src/platform/evidence/ledger.ts` for standalone records, or its
corresponding SQL RPCs inside a domain transaction. Store `ObservationV1` with actual
facts, `DecisionV1` with a complete state-at-decision JSON snapshot, and `OutcomeV1`
with the decision revision. Monetary values remain exact strings. Snapshots, hashes,
observations, outcomes and action links cannot be edited/deleted. Corrections append
new identities/revisions; they do not rewrite the old decision.

After preparing an AUTH action, call `link_decision_action` inside the caller's SQL
transaction if the business operation requires atomic linkage. It verifies stored
same-business decision/action subjects. It does not authorize the action. AUTH remains
the sole approval/attempt owner. No competing attempt store is introduced.

Forward triggers capture actual action, bound approval and attempt transitions and
publish their evidence in the **same** transaction. The strict internal adapter names
are `platform.action.state_recorded`, `platform.approval.state_recorded`, and
`platform.attempt.state_recorded`, envelope version 1. They carry a native AUTH record
and must not be represented as Controller `ActionV1`/`ExecutionV1`. SQL validates the
payload against the stored evidence row; TS readers have strict native schemas.
Capture no-ops are suppressed. Existing records are labelled `adoption_snapshot`,
not reconstructed history. Reconciliation preserves the earlier unknown snapshot.

Controller must register/validate its `controller.invoice.drafted` payload and call
publication inside BILL's invoice/allocation/snapshot transaction. The generic SQL
transport validates envelope/scope, not domain arithmetic. Invoice issuance facts need
the same atomic integration in Controller's forward migration. AUTH native state facts
are not substitutes for invoice creation, delivery or settlement facts.

## Read interface and explicit uncertainty

`read_decision_evidence(org, decision_id, revision)` returns the immutable decision
snapshot, observations, linked native actions/approvals/attempts/history and outcomes.
`read_event_delivery(org,event_id)` returns the envelope and consumer receipt status,
reason and owner, excluding lease tokens. Missing rows return null.

Authenticated server routes: `GET /admin/evidence/decisions/:id/:revision` and
`GET /admin/evidence/events/:id`. They fail closed without the configured admin token,
derive company from the trusted deployment, reject query overrides, return 404 for
absence and 503 for unavailable storage. A console server can call these with its
server-held credential after AUTH acceptance; never expose it to the browser.

Execution status is `pending`, `failed`, `unknown` or `confirmed`. An expired running
attempt is shown as unknown and requires reconciliation of its existing identity.
No attempt/outcome is fabricated when absent. A confirmed generated document is not
printing, delivery, cash collection or business benefit. Outcome absence is explicitly
unknown; recorded outcome windows retain their individual status/reason/metrics.

## Verification and remaining gates

Focused HTTP boundary tests exercise schema validation, scope, fail-closed reads,
replay mutation refusal and actual legacy replay with the real Controller registered.
`scripts/verify-event-evidence.sql` exercises real transaction rollback, duplicates,
fencing, gaps/conflicts, unknown versions, replay, immutable snapshots, exact amounts,
cross-business linkage/read refusal, unknown attempts and preserved reconciliation.
`scripts/verify-event-concurrency.sh` uses separate Postgres sessions and terminates
a real worker after its claim commits; checks concurrent publication/claims/completion
and stale fencing. Both run in the disposable CI pgvector database, alongside existing
migration, AUTH/DATA concurrency and SQL↔TS parity suites.

Local Postgres/pgvector is unavailable; real SQL acceptance comes from actual CI on
the named candidate. Generated database types must be obtained from that migrated
database and committed, not handwritten. Initial PR is draft until checks pass.

Remaining integration gates: repaired AUTH exact commit, Controller transaction hooks,
authenticated console journey, independent review on the final combined candidate.
The deployment binding is intentionally single-business; direct SQL service callers
must be trusted and supply the business established by their server/job authority.
Cross-business storage tests do not establish full TENANT-01 readiness. No automatic
memory promotion, new execution authority, live invoice, provider call or deployment.
