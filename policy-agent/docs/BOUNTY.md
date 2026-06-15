# Bounty Submission — Atlas Policy Agent

This document is the long-form companion to the README. It's targeted at the
Week 5 bounty judges and at future Atlas readers.

## What it is

**Atlas Policy Agent** is a policy-constrained AI payment agent on Hedera.
The agent receives a natural-language intent to pay a creator. Before any
HBAR moves, a deterministic policy engine evaluates the proposed payment
against a rule set and returns `allow`, `block`, or `escalate`. Only on
`allow` does the agent execute an on-chain transfer via the Hedera Agent
Kit. Every decision and every receipt is written immutably to the Hedera
Consensus Service.

The packaged demo is **conversion-gated creator payouts**: payouts are
gated by a verified attribution event recorded on HCS, so the agent only
pays when the conversion is real, the amount is within terms, and the
order hasn't already been paid.

## Why it satisfies the safety rule structurally

The bounty's hardest requirement is: *"it must be impossible to drain a
user's funds without explicit consent."*

Most implementations chase this with prompt discipline — system messages
telling the LLM not to bypass the policy check. That fails the moment the
LLM is jailbroken, tricked, or hallucinates.

We satisfy the rule **structurally** instead:

1. The Hedera SDK's `TransferTransaction` is wrapped in
   `src/hedera/transfer.ts` as `transferHbar()`.
2. The wrapped payment tool in `src/agent/tools/payCreator.ts` is the
   **only** file in the entire `src/` tree that imports or calls
   `transferHbar()`.
3. `payCreator()`'s code reads top-to-bottom: build state → evaluate →
   switch on decision. `transferHbar()` is reached *only* on the `allow`
   branch (or after an operator-confirmed `escalate`).
4. The LLM is given a single tool — `pay_creator` — which is the wrapped
   tool. The LLM has no `transferHbar` tool to call, hallucinate, or be
   tricked into calling.

These four properties are *not* aspirational documentation; they are
enforced by `test/interception.test.ts`, which walks the whole `src/`
tree, fails the build if any file outside `payCreator.ts` references
`transferHbar`, and verifies that `evaluate()` appears before
`transferHbar()` in the wrapped tool's source. The test runs in CI on
every commit.

This is the same pattern Atlas uses for its deterministic-money boundary
on the wholesale-invoicing slice (Atlas §10): Claude can narrate, triage,
and explain, but **never writes the books**.

## How HCS does double duty

Two HCS topics:

- **Conversions topic** — verified attribution events that *trigger*
  payouts. These are the source of truth for the conditional-gate rule:
  the engine looks for a matching `(creatorCode, orderId, verified)`
  message and refuses to pay without one.
- **Audit topic** — every policy decision (allow / block / escalate) AND
  every on-chain receipt, written immutably as it happens.

A single Hedera-native primitive — append-only HCS messages — carries
both the proof that authorises a payment and the proof that the payment
happened. The audit topic is queryable from the CLI and any future
console: the entire payout history of every creator is one mirror-node
fetch away.

## The policy engine (the IP)

The engine is **pure**: no chain dependency, no I/O. Inputs are a typed
`Payment`, a `PolicyState`, and a `RuleConfig`. The output is a `Decision`
with the aggregated outcome and the list of reasons every rule
contributed.

Seven rule types ship in this submission:

| Rule | Decision | Phase 0 demo target |
|---|---|---|
| `perTransactionCap` | block above ceiling | safety net |
| `rollingWindow` | block when sum-in-window would breach | scenario 2 |
| `velocityLimit` | block when count-in-window would breach | safety net |
| `allowlist` / `denylist` | block when recipient/creator absent / present | scenario 3 |
| `approvalThreshold` | escalate (not block) above threshold | scenario 4 |
| `conditionalGate` | block without matching verified conversion + commission-rate check | scenario 3 |
| `idempotency` | block already-paid orderId | scenario 5 |

Precedence is **block > escalate > allow** — any blocking rule wins, then
any escalating rule, otherwise allow. The reasons array carries every
triggering rule's explanation so the audit log has full provenance.

Tinybar arithmetic throughout — no JavaScript float drift on money.

## Demo scenarios (run via `npm run demo`)

The five scenarios from the build brief §9. Each is a separate intent
into the wrapped tool. The CLI prints the decision, reasons, and (where
applicable) a HashScan URL for the on-chain transfer.

1. **Happy path** — verified ABC conversion within all caps → `allow` →
   real testnet HBAR transfer + audit message.
2. **Rolling cap hit** — verified ABC conversion that would breach the
   500 HBAR / 168h cap → `block` (rolling window) → no transfer + audit
   message.
3. **Not allowlisted** — payout requested for creator ZZZ not on the
   allowlist → `block` → no transfer + audit message.
4. **Over threshold** — verified DEF conversion above the 50 HBAR
   approval threshold → `escalate` → CLI HITL prompt → "y" → transfer +
   audit message.
5. **Duplicate** — re-run scenario 1's already-paid `orderId` → `block`
   (idempotency) → no transfer + audit message.

## Atlas portfolio framing

This repo is the **policy-payments primitive** Atlas reuses across its
ventures. For the bounty it ships standalone with a JSON rule config and
a CLI demo. The productization path (post-bounty):

1. Replace seeded conversions with a live Shopify attribution feed.
2. Move rules from JSON → Supabase; add a configuration UI.
3. Add FX (order currency → payout currency) and USDC support.
4. Ship as an Atlas Growth Engine add-on for DTC clients (first dogfood:
   VICE creator payouts).

None of that is in scope for the bounty submission. The architecture is
deliberately built so each productization step is a self-contained PR
that doesn't disturb the policy engine or the interception invariant.

## Tech stack

- **Language**: TypeScript (strict, no implicit any, noUncheckedIndexedAccess)
- **Agent framework**: LangChain (JS) — `createReactAgent` with one tool
- **LLM**: Claude via `@langchain/anthropic` (`ChatAnthropic`)
- **SDK**: `hedera-agent-kit` 3.x + `@hashgraph/sdk` directly for transfer
  and HCS
- **Network**: Hedera Testnet
- **Rule storage**: JSON config (`policy.config.json`)
- **Demo**: CLI

## Tests

- `npm run typecheck` — strict TS, no errors
- `npm test` — 24 tests covering every rule type, the aggregator, the
  empty-config edge case, and the interception invariant
- All deterministic and chain-free — runs in milliseconds in CI

## Feedback issue

A real issue filed on `hashgraph/hedera-agent-kit-js` based on friction
hit during the build. Link tracked in the submission form.
