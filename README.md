# Atlas

Vertical AI management platform (Jarvis for VICE): a shared data substrate plus a team of agentic
employees, each owning a domain, coordinated by an assistant/orchestration layer that executes
work and reports business activity to the operator. v1 is VICE-specific; v2+ generalizes across
businesses.

The **Controller** (Finance) is Agent #1 — built end-to-end first as the vertical slice. The
real data shape teaches what a speculative second agent would guess wrong.

## Status — Phase 0

Phase 0 is the substrate + thin spine + canonical sync. It establishes:

- Repo scaffold + config + all migrations (`supabase/migrations/0001`–`0009`).
- Append-only `event_log` spine + projection dispatch (CQRS).
- Thin agent contract + registry + base worker.
- Control plane: approvals, risk tiers, audit log.
- Tool registry + transactional outbox + agent→tool grants.
- Observations write path (memory is designed-in; consolidation/retrieval deferred).
- Shopify canonical sync (products, all orders, all customers — idempotent).
- Shopify fulfillment webhook (HMAC verified) → event → `shopify_fulfillments` →
  location routing → `fulfillment_events`.

No live database is used in this phase — migration files are the source of truth.

## Layout

```
atlas/
  supabase/migrations/        # 0001..0009 — applied in order; never edited after merge
  src/
    data/                     # canonical read-models access + generated types
    platform/
      events/                 # event_log append + projection dispatch
      memory/                 # observations write/read; consolidation = deferred
      agent/                  # thin contract: types, base worker, registry
      control-plane/          # approvals, risk tiers, autonomy capture, audit
      tools/                  # tool registry: permissioned, risk-tiered, audit-wrapped + outbox
      orchestration/          # event/schedule dispatch + task state
      reporting/              # digest builder (rolls up agent_activity)
      assistant/              # NL over memory + read-models (Claude, read-only v1)
    integrations/             # shopify/, stripe/, anthropic/
    agents/controller/        # Agent #1 Finance
    api/                      # service API consumed by human surfaces
  web/                        # console (Next.js) — Phase 2
  test/
```

## Deterministic boundary (platform-wide invariant)

Deterministic code owns pricing, all arithmetic, every ledger posting, state transitions,
reconciliation, due dates. Claude owns exception triage, approval reasons, invoice/dunning/
statement copy, anomaly explanations, NL queries, digest narration, memory consolidation
narration. **No agent's Claude/memory path ever writes the books.**

## Next phases

- Phase 1 — Controller agent end-to-end (wholesale slice).
- Phase 2 — human surfaces (web console, digests, conversational assistant).
- Deferred — memory consolidation + pgvector retrieval, approval-as-training autonomy graduation,
  consignment v1.1, inter-co v1.2, DTC ledger posting, Agent #2 (Growth), v2+ generalization.
