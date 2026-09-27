# Bounded parallel tracks

Use the repository queue for current claims/status, the table below for stable briefs.
Contract version 1 must merge before dependent implementations merge. Tracks can build
against a named contract commit with synthetic fixtures while it is reviewed. A branch
name alone is not a stable dependency. Each track owns an isolated branch/PR.

| Track / task | Deliverable and expected surfaces | Dependencies / merge constraint | Acceptance and cross-module impact |
| --- | --- | --- | --- |
| Integration / ARCH-01 | Foundation docs, reference schemas, fixtures, queue reconciliation | Existing bootstrap baseline; foundation merges first | Consistent contracts and evidence; no runtime compliance claim; shared types/events reviewed |
| Authorization / AUTHZ-02 | Persist exact intent and approval binding at API/tool/DB boundary | AUTHZ-01 + ARCH-01 | Changed/expired/forged/wrong-business intent refused; preserves approval history |
| Event infrastructure / EVENT-01 | Event adapters, durable publication, consumer receipts and replay guards | ARCH-01; coordinate DATA-01 changes | Real DB duplicate/concurrency/crash/replay evidence; all modules share transport guarantees |
| Controller / existing DATA-01, PRICING-01, BILL-01, FLOW-01 | Complete the declared receivables journey using shared services | Preserve existing queue dependencies; FLOW-01 also needs EVENT-01 | Correct partial allocations, bounded execution, bank reconciliation or owned exceptions |
| Operator / UI-01 | Decision/approval detail and unresolved execution views | Prototype against ARCH-01 fixtures; integrate after AUTH/FLOW dependencies | Operator can understand evidence, decide and recover without direct API calls |
| Evidence / EVIDENCE-01 | Durable observation/decision/action/attempt/outcome linkage and read interface | ARCH-01; runtime integration with AUTHZ-02/EVENT-01/FLOW-01 | State-at-decision preserved; unknown outcome explicit; no automatic memory promotion |
| Verification / VERIFY-ARCH-01 | Independent read-only review and journey verification | Candidate commits from affected tracks | Architecture, tenant isolation, failure recovery and evidence checked against exact revision |
| Other module preparation | Module briefs, adapter investigation and read-only prototypes | Relevant identity/source contracts; separately claimed bounded queue item | No private shared schemas, new business effects or change to programme priorities |

Each brief declares objective, non-scope, risk, affected contracts, acceptance and required
evidence. Synthetic fixtures confer no live action mandate. Shared-file collisions go to
the Integration Architect before divergent edits; one track owns each shared change.
Contracts, approval/policy and event delivery are high-consequence boundaries even when
their reference fixtures have no side effects. Runtime changes need independent review.

Review at track start, shared-contract amendment, before merge, after related merge waves
and before production readiness. Routine work inside an accepted boundary proceeds
without a central design approval for every implementation choice. Review reports list
contract deltas, consumers, cross-module opportunities, conflicts, authority/evidence
impacts, required follow-up and merge order.

Suggested merge wave: ARCH-01 → independently ready AUTHZ-02/EVENT-01 and existing
data/pricing work → integrated EVIDENCE-01/FLOW-01/UI-01 → VERIFY-ARCH-01 journey gate.
Actual prerequisites in the queue override this illustration; never reorder existing
business tasks or merge another track merely because its historical checks are green.
