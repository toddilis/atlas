# Atlas

Vertical AI management platform (Jarvis for VICE): a shared data substrate plus a team of agentic
employees, each owning a domain, coordinated by an assistant/orchestration layer that executes
work and reports business activity to the operator. v1 is VICE-specific; v2+ generalizes across
businesses.

The **Controller** (Finance) is Agent #1 — built end-to-end first as the vertical slice. The
real data shape teaches what a speculative second agent would guess wrong.

## Status

Tracked in **`PLAN.md`** (the standing reference: module roadmap, decision log, phased
PR slices with acceptance checkboxes). Shipped so far:

- **Phase 0** — substrate: event spine (append-only `event_log` + projection dispatch),
  agent contract + registry, control plane (approvals / risk tiers / audit), tool
  registry + transactional outbox + grants, observations write path, Shopify canonical
  sync + HMAC-verified fulfillment webhook → routing.
- **Phase 1 (PR-A…PR-F)** — the Controller's wholesale loop end-to-end: policy engine,
  `issue_invoice` through the approval gate, Stripe outbox + payment ingestion + ledger
  posting, pricing resolver + `draft_invoice`, GST, account statements.
- **Phase 2 start (PR-G…PR-H)** — operator console scaffold: approvals queue,
  invoice browser, statement preview (read-only).
- **Phase 2.5 (PR-J…PR-N)** — hardening from the code review: projection durability +
  replay, single-transaction payment ingestion, admin bearer auth + outbox reaper +
  single-use approvals + audit immutability triggers, CI on real Postgres + typed
  Supabase client + SQL↔TS parity, statement aging/reconciliation correctness.

### Verification (living, in CI)

Every push runs three jobs (`.github/workflows/atlas-ci.yml`):

1. `typecheck + unit tests` — strict `tsc` over `src`/`test`/`scripts`, `node --test`.
2. `migrations + RPC probes + SQL⇄TS parity` — applies every migration in order to a
   real Postgres (pgvector image) via `scripts/verify-migrations.sh`, then runs its
   behavioural suites: projection-state trigger/backfill, immutability triggers, dedup
   keys, RPC execution probes, payment atomicity (exactly-once, stranded-heal),
   control-plane integrity, and statement aging/reconciliation. `scripts/sql-ts-parity.ts`
   then executes the SQL money functions and compares them with their TS mirrors.
3. `console typecheck + build`.

Regenerate DB types after adding a migration: `npm run gen:types` (spins an ephemeral
cluster from the migrations — no live project needed). `VERIFICATION.md` is the
historical Phase 0 verification record.

Deployment (Fly.io API + worker, Vercel console): see `DEPLOY.md`.

## Layout

```
atlas/
  supabase/migrations/        # 0001..0020 — applied in order; never edited after merge
  scripts/                    # verify-migrations.sh, sql-ts-parity.ts, gen-types.sh
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
      pricing/                # price-book resolver + GST + aging
      ledger/                 # double-entry posting helpers
    integrations/             # shopify/, stripe/, anthropic/
    agents/controller/        # Agent #1 Finance
    api/                      # service API consumed by human surfaces
  web/                        # operator console (Next.js 14 App Router) — Phase 2
  test/
```

## Phase 2 — operator console

Read-only Next.js app under `web/`. First slice is the approvals queue (PR-G):
pending agent actions that the policy engine escalated. Authentication, write
actions (approve/deny), and the conversational assistant arrive in later PRs.

```
cd web
cp .env.example .env.local      # fill SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ATLAS_ORG_ID
npm install
npm run dev                     # http://localhost:3002
```

Service-role key bypasses RLS — fine for the single-operator v1; auth-scoped
access lands when authentication does.

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
