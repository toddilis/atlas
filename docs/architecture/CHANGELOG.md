# Architecture pack v0.2 — 2026-09-27

Adopts the original eleven-document pack as the shared foundation, retaining the
historical ADR-001 and adding ADR-002 for repository integration and staged adoption.

| Review finding | Resolution |
| --- | --- |
| Conceptual contracts not executable | Controller v1 TypeScript/Zod schemas, valid chain and invalid fixtures, event registry, compatibility rules |
| Approval not bound to exact intent | Decision/action revisions, immutable intent fingerprint, expiry/revocation and current policy requirements |
| Execution contract missing | Distinct attempt records, state graph, confirmation evidence, retry/reconciliation and compensation rules |
| Shared queue missing from pack | Existing repository queue extended; dated export snapshot with single-source rule |
| Delivery/replay guarantees undefined | At-least-once transport, scoped deduplication, atomic receipts/outbox, ordering and replay side-effect guard |
| State/source authority unclear | Source ownership/freshness matrix and visible conflict/missing-source behavior |
| Parallel implementation boundaries unclear | Bounded track briefs, contract-first merge dependencies and independent verification gate |
| Demand signal naming drift | DemandSpikeDetected standardised; legacy wire names preserved with explicit mappings |
| Approval learning could imply greater authority | Roadmap aligned to outcome-backed learning and separately authorized governance |

See [validation](VALIDATION.md) and [runtime adoption gaps](ADOPTION_AND_GAPS.md).
No existing provider, approval handler, database schema or console behavior is changed.
