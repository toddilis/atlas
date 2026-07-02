# Atlas — development plan

Tracked plan for Atlas. Checkboxes are updated in the PR that lands them; each PR
references its section here. Decisions that change scope get a row in the decision log
(§3) rather than silent edits.

Atlas is **internal vertical AI software built as modules over one shared substrate**.
Finance (the Controller) is module #1. Marketing is module #2. The platform exists so
that each new module is a registration, not a rebuild.

---

## 1 · Product shape: modules over a substrate

Two layers, one rule: **the platform never knows about a specific business domain; a
module never talks to another module except through the platform.**

### Platform (shared substrate — `src/platform`, `src/data`, `src/api`, worker)

- Event spine (`event_log` append + projection dispatch + replay)
- Policy engine + control plane (approvals, audit, autonomy graduation)
- Tool registry, grants, transactional outbox
- Memory (observations → consolidation → retrieval)
- Reporting (digest builder) and assistant core (read-only NL)
- Operator console shell (auth, nav, dashboard frame)

### Module (a vertical AI employee — e.g. `src/agents/controller`)

A module owns a business domain end-to-end and plugs in by registering:

| Registration | Finance example |
|---|---|
| Agent + event subscriptions | Controller ← `shopify.fulfillment.created`, `stripe.invoice.paid` |
| Tools (+ risk tiers, policy extractors) | `draft_invoice`, `issue_invoice`, `generate_statement` |
| Projectors (canonical read-models) | fulfillments → routing → `fulfillment_events` |
| Policy rules | caps / velocity / approval thresholds for `controller.*` |
| Integrations | Shopify, Stripe |
| Migrations (module read-models) | invoices, ledger postings, statements |
| Console surface | approvals detail, invoice browser, statement preview |
| Digest contribution | issued/paid/overdue rollup for the dashboard |

### Boundary rules (enforced in review, formalized in Phase 5)

- Modules never import from other modules. Cross-module effects travel via the event
  spine and canonical read-models only.
- Platform code never imports module code, except the boot manifest that registers
  enabled modules (today: `orchestration/dispatch.ts`).
- Deterministic code owns all money math, state transitions, and side effects. Claude
  narrates, triages, and proposes — in every module, forever.
- Every mutation from every surface (agent, console, assistant) passes through the same
  policy gate. No admin backdoor.

We deliberately do **not** build a plugin framework now. Folder convention + boot
manifest carries us until the Marketing module forces the real interface (§9) — the
second consumer defines the contract, not speculation.

---

## 2 · Operator interaction model

Atlas is **managed by exception, not driven by commands**. The operator employs it.
Three verbs: **set policy, decide exceptions, stay informed.**

```
external events          agents act                operator touches
─────────────────        ──────────────────        ─────────────────────────
Shopify fulfillment  →   Controller drafts,    →   nothing (within policy)
Stripe payment       →   issues, posts,        →   approvals queue (escalated)
worker schedule      →   reconciles            →   dashboard digest (push)
                                               →   assistant (pull, ad-hoc)
```

1. **Agents work autonomously inside policy.** Within-tolerance actions never
   interrupt. Everything lands in `agent_activity` (narrative) and `audit_log` (proof).
2. **The policy engine escalates; the operator decides.** An approval shows the
   proposed action, amounts, machine reasons, and a Claude-written summary of why it
   deserves attention. Approve/reject with a reason. Decisions execute exactly once.
3. **Approvals are training data.** Decision history is projected into facts the
   control plane reads, so a repeatedly-approved (agent, action) graduates toward
   auto-tier — each loosening ratified by the operator through the same queue.
4. **The dashboard keeps you informed without being asked.** The console home is a
   tailored dashboard: deterministic daily rollup, Claude-narrated summary, and a
   needs-attention list (pending approvals, overdue accounts, dead-lettered jobs).
   Per decision D2, this replaces email digest for v1.
5. **The assistant answers what the dashboard doesn't.** NL over read-models + memory,
   read-only by locked contract. Its future write path is proposing approvals into the
   queue — never acting directly.

Surfaces: **console** (dashboard, queue, browse, policy settings — the single pane),
**approvals** (the only place Atlas waits on a human), **assistant** (in-console chat).

---

## 3 · Decision log

| # | Date | Decision |
|---|---|---|
| D1 | 2026-07-02 | Deploy during hardening: containerized API + worker on a managed host (Fly/Railway/VPS — pick at implementation); console on Vercel. |
| D2 | 2026-07-02 | Digest ships as the console dashboard (tailored home page), not email, for v1. |
| D3 | 2026-07-02 | Console auth v1 = auth-gated server-side service role (Supabase Auth, single operator). Real RLS (org GUC, per-role policies) deferred to v2 multi-tenant. |
| D4 | 2026-07-02 | Scheduling via a dedicated worker process (not pg_cron) — it also hosts replay, outbox drain, digest build, and later consolidation. |
| D5 | 2026-07-02 | Atlas is explicitly modular: platform substrate + vertical modules (Finance now, Marketing next). Boundary rules in §1. |

---

## 4 · Shipped (history)

- [x] **Phase 0** — substrate: migrations 0001–0010, event spine, agent contract,
      control plane, tool registry + outbox, observations, Shopify canonical sync,
      HMAC-verified fulfillment webhook + routing.
- [x] **Phase 1 (PR-A…PR-F)** — Controller wholesale loop end-to-end: policy engine,
      `issue_invoice` through the gate, Stripe outbox + payment ingestion + ledger
      posting, pricing resolver + `draft_invoice`, GST, account statements.
- [x] **Phase 2 start (PR-G…PR-I)** — console scaffold, read-only approvals queue,
      invoice browser + statement preview, 0016 RPC fix-forward.

---

## 5 · Phase 2.5 — Hardening (gates everything below)

Close the failure-path gaps found in review. **Nothing in Phase 2b ships to real
counterparties until PR-J, PR-K, and PR-M are merged.**

### PR-J — Projection durability
- [ ] `projection_failures` table; failed dispatch recorded, not just logged
- [ ] `replay()` implemented with commit-safe checkpointing (no max-seq skipping)
- [ ] Idempotent redelivery re-dispatches projectors for unprojected events
- [ ] Webhooks return non-2xx where provider retry is wanted
- [ ] Acceptance: kill the process mid-webhook → redeliver → canonical state converges;
      fulfillment-before-order race heals via replay

### PR-K — Payment atomicity
- [ ] `payments` insert moved inside `post_payment_received` (single transaction)
- [ ] Internal already-posted guard (idempotent re-invocation, no double ledger post)
- [ ] Acceptance: crash between old insert/post points → redelivery posts exactly once

### PR-L — Control-plane integrity
- [ ] Bearer auth on all API routes (admin drain/sync included)
- [ ] Outbox reaper: stale `in_flight` rows recovered with lease expiry
- [ ] Approvals single-use (consumed on execute) + `expires_at` enforced
- [ ] `audit_log` immutability triggers (same mechanism as `event_log`)

### PR-M — Verification backbone
- [ ] CI job: apply migrations 0001→current to ephemeral Postgres, exercise all RPCs
- [ ] `createClient<Database>` typed client; regenerate `database.types.ts`
- [ ] SQL↔TS parity tests for GST and aging (the boundary claimed in comments)
- [ ] `npm ci` in CI; test files included in typecheck

### PR-N — Statement correctness + polish
- [ ] Real 61–90 aging band; bucket labels match cutoffs
- [ ] Closing balance and aging buckets reconciled (one derivation, or asserted equal)
- [ ] Calendar-day aging in `Pacific/Auckland`
- [ ] Tailwind `content` globs include `./components`; web `error.tsx`/`loading.tsx`
- [ ] README/VERIFICATION refreshed to describe the current system

### PR-O — Deployment (D1)
- [ ] Dockerfile (API + worker), deploy to managed host; console on Vercel
- [ ] Health checks probe DB + env, not just process-up
- [ ] Secrets via host env; graceful shutdown (SIGTERM drains in-flight work)

---

## 6 · Phase 2b — Close the operator loop

The interaction model (§2) becomes real. End state: morning dashboard → decide the
escalated items → ask the assistant a follow-up → done.

### PR-P — Console auth (D3)
- [ ] Supabase Auth, single operator account, middleware-gated routes
- [ ] Service-role key stays server-side behind the auth gate

### PR-Q — Approve/deny in the console + module-aware shell
- [ ] Server actions → `decideApproval` → hardened `executeApproved`
- [ ] Decision reason captured (required on reject) — this is the training signal
- [ ] Activity stream view (per-module filter)
- [ ] Console nav driven by a module manifest (finance today; marketing slots in)

### PR-R — Worker process (D4)
- [ ] Long-running worker: schedules Shopify sync, outbox drain, approval expiry,
      projection replay, dashboard rollup build
- [ ] Job runs recorded (start/finish/error) and surfaced on the dashboard
- [ ] Acceptance: Atlas processes a full day unattended — sync → draft → escalate →
      (operator decides) → issue → payment → ledger — with no manual endpoint pokes

### PR-S — Dashboard digest (D2)
- [ ] Console home = tailored dashboard: daily/weekly deterministic rollup
- [ ] First production Claude call: narration over the rollup (never computes figures)
- [ ] Needs-attention list: pending approvals, overdue accounts, dead-lettered outbox,
      projection failures
- [ ] Built from per-module digest contributions (finance first)

### PR-T — Assistant v1
- [ ] In-console chat; read-only by contract (`assistant.ts` §10 boundary)
- [ ] Whitelisted query tools over read-models + activity + memory; no write tools
- [ ] Answers cite the rows/queries they used

---

## 7 · Phase 3 — Memory + autonomy graduation

- [ ] Consolidation worker: observations + approval decisions → `semantic_facts` /
      `episodic_summaries`, pgvector embeddings
- [ ] Retrieval wired into digest narration and assistant context
- [ ] Autonomy graduation: per-(agent, action) threshold proposals from decision
      history — ratified through the approvals queue (policy changes are themselves
      approval-gated)
- [ ] Fix `conditionalGate` precondition amounts (graduated autonomy leans on it)

## 8 · Phase 4 — Widen the finance module

- [ ] Consignment v1.1: movements → consignment statements
- [ ] DTC ledger posting (chart codes already seeded)
- [ ] Inter-co v1.2
- [ ] Each reuses the same loop: new event types → deterministic posting → exceptions
      to the same queue

## 9 · Phase 5 — Marketing module + platform generalization

The platform claim gets tested: the Marketing (Growth) module should require **zero
substrate changes** — an agent registration, tools + grants, projectors, policy rows,
console pages, digest contributor. Whatever it *does* require is the generalization
backlog, fixed in the platform, not patched in the module.

- [ ] Formal module manifest (registration interface extracted from the two consumers)
- [ ] Marketing module v1 (scope defined nearer the time — likely Klaviyo/Shopify
      marketing read-models + campaign proposals through the approvals queue)
- [ ] v2 multi-tenant: real RLS (org GUC set per-request), roles, per-module
      enable/disable per org

---

## 10 · Standing invariants

1. Deterministic code owns pricing, arithmetic, ledger postings, state transitions,
   due dates. Claude owns narration, triage, summaries, NL — and only that.
2. Every mutation from every surface goes through the policy gate.
3. The event spine is append-only and replayable; canonical state is derivable.
4. Modules are islands: spine and read-models are the only bridges.
5. Autonomy is earned per (agent, action) and ratified by the operator — never assumed.
