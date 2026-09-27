# Event delivery and recovery contract

Events record facts, detections or proposals explicitly. Persist local state transitions,
evidence and outbox continuation in one database transaction. Workers deliver at least
once. No global ordering or end-to-end exactly-once delivery is promised.

- Scope source deduplication by company, connection, source event identity and type.
  Scope consumer receipts by company, consumer and canonical event ID. Repeated provider
  identifiers in different businesses/connections are independent.
- Consumers commit receipts and projection updates atomically. A failed transaction
  leaves the event retryable. Two concurrent deliveries cannot apply the same effect twice.
- Use per-subject versions for ordered projection updates. Ignore an already-applied
  version only with matching identity/content; conflicting same-version data is an exception.
  Older arrivals cannot overwrite newer state. Missing predecessor versions trigger bounded
  source reconciliation; never assume arrival order proves business order.
- Immutable corrections carry source references and supersession links. Preserve prior
  evidence and invalidate/re-evaluate dependent decisions when material state changes.
- Bound retries with persisted attempt count and configured backoff. Exhaustion, unknown
  versions or invalid payloads enter a visible quarantine with reason, owner and resume path.
- Replay rebuilds projections and derived evidence in an explicitly side-effect-disabled
  context. Tool dispatch is forbidden in replay. Production command recovery uses existing
  action identities and reconciliation, not event replay to create fresh effects.
- Preserve correlation/causation, occurrence/observation times and evidence references.
  Root events have null causation; downstream events reference their actual cause.

Implement in EVENT-01 alongside existing event-log/outbox facilities. Add database cases
for atomicity, concurrent duplicate consumers, crash recovery and out-of-order correction.
These guarantees are requirements, not claims about the current dispatcher/projectors.
