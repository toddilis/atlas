# Adoption status and implementation gaps

Baseline: local bootstrap revision `3d0e3f6195ce2304ccb75baf091f181ab1d89cd4`.
Read current remote PRs again before implementing; this is not a deployment inventory.

| Requirement | This revision | Runtime owner / evidence still needed |
| --- | --- | --- |
| Foundation and bounded parallel work | Documents, task briefs, queue metadata | Integration review on each merge wave |
| Typed decision/action/outcome contracts | Executable reference schemas and fixtures | AUTHZ-02/EVIDENCE-01 adopt at trusted boundaries with forward migrations |
| Exact approval + current policy | Reference fingerprint/linkage validation and documented guards | AUTHZ-02 real DB/API negative cases; legacy consumed rows reconciled |
| Action versus attempt/recovery | State graph and evidence requirements | FLOW-01 durable attempts, provider capability and restart verification |
| Delivery, deduplication and replay | Explicit required guarantees | EVENT-01 transactional DB tests and integration evidence |
| Source ownership/freshness | Source matrix and failure behavior | DATA-01/PRICING-01/FLOW-01 enforce configured source contracts |
| Outcome learning | Evidence hooks and explicit unknowns | EVIDENCE-01 capture; later scoped promotion task, independently verified |
| Multiple businesses | Identity/reference fixtures | PLAT-01 and TENANT-01 boundary tests; schema fields alone prove no isolation |

## Required journey gate

Exercise dispatch → invoice snapshot → decision → approval → durable attempt → confirmed
declared effect → visible operator status → outcome hook. Test duplicates, concurrent
workers, changed amount/recipient/subject, expiry/revocation, grant denial, worker crashes
on both sides of provider calls, uncertain responses, stale sources, ambiguous bank
matches, cross-business substitutions and model unavailability. Replay must not dispatch
tools. Known no-effect retries keep the same effect identity; uncertainty reconciles first.
Every result is tied to the candidate commit; revised code invalidates affected evidence.

Reference schema/unit tests validate only syntax and pure linkage rules. Database/API,
browser, connector and live pilot evidence are separate gates. Do not mark them passed
because the fixture tests pass. Existing migration and parity checks apply when runtime
schema changes land. No production migration or provider action occurs in this revision.

## Compatibility rollout

Inventory consumers and pending legacy approvals/actions; add forward storage migrations
and trusted adapters in the owning tasks. Validate new readers before enabling new
writers. Preserve original event versions and distinguish missing historical evidence.
Backfill only verifiable mappings; quarantine ambiguous records for reconciliation.
Deploy by an explicitly scoped business/workflow flag, monitor invalid-contract counts,
approval refusals, event lag/quarantine, unresolved age and duplicate suppression.
On rollback, disable new action writers, preserve audit and continue reconciliation;
never reissue a pending effect through an old path or destructively undo evidence.
