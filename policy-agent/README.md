# Atlas Policy Agent

[![CI](https://github.com/toddilis/atlas/actions/workflows/policy-agent-ci.yml/badge.svg)](https://github.com/toddilis/atlas/actions/workflows/policy-agent-ci.yml)

> **Note on repo location.** This codebase will be the public bounty
> submission repo `toddilis/atlas-policy-agent`. It's temporarily living
> in the `policy-agent/` subdirectory of `toddilis/atlas` while the
> session scope is sorted out; before the Hedera Week 5 bounty
> submission on 21 June 2026, this subdirectory is extracted to its own
> public repo (the destination already exists).

A policy-constrained AI payment agent on Hedera. An LLM agent receives a
natural-language payout intent; before any HBAR moves, a deterministic
**policy engine** evaluates the payment against a rule set and returns
`allow`, `block`, or `escalate`; only on `allow` does the agent execute an
on-chain transfer via the Hedera Agent Kit; every decision and receipt is
written immutably to the **Hedera Consensus Service**.

The demo scenario is **conversion-gated creator payouts**: a payout is
gated by a verified attribution event recorded on HCS, so the agent only
pays when the conversion is real, the amount is within terms, and the
order hasn't already been paid.

**Built for the Hedera AI Agent Bounty, Week 5** (Policy Agent). Public
repository owned by Atlas / HoldCo IP.

## How HCS does double duty

- **Conversions topic** — verified attribution events that *trigger*
  payouts.
- **Audit topic** — every policy decision and every transfer receipt; the
  immutable record.

The same Hedera-native primitive carries the proof that authorises a
payment AND the proof that the payment happened.

## Architecture

```
CLI intent
    │
    ▼
LangChain agent (Claude via ChatAnthropic)
    │  picks the wrapped payment tool — the ONLY way to spend funds
    ▼
Policy engine — evaluate(payment, state) → allow | block | escalate
    │                       │                        │
    │ block                 │ escalate               │ allow
    │ ───► audit only       │ ───► CLI HITL prompt   │
    │                       │       (yes/no)         │
    │                       │                        ▼
    │                       │       ┌── Hedera Agent Kit ──┐
    │                       │       │  transferHbar(...)   │
    │                       │       └──────────────────────┘
    │                       │                        │
    │                       │                        ▼
    │                       │              Hedera Testnet
    │                       │                        │
    └────►─────────►────────┴────────►───────────────┴─────► HCS audit topic
```

The agent never sees an "unsafe" transfer tool — the only payment-shaped
tool wraps `evaluate()`. A `block` decision **cannot** reach the chain.
This is what satisfies the bounty's "cannot drain funds without consent"
safety rule structurally rather than by prompt discipline.

## Quick start

```bash
# 1. Create a Hedera testnet account at https://portal.hedera.com/dashboard
# 2. Fill in .env
cp .env.example .env
$EDITOR .env

# 3. Install
npm install

# 4. Sanity check the rail
npm run hedera:hello       # makes one HBAR transfer to DEMO_RECIPIENT_ID

# 5. Create HCS topics (writes ids back to .env / .topics.json)
npm run hedera:topics

# 6. Seed verified conversions for the demo
npm run demo:seed

# 7. Run the 5-scenario demo
npm run demo
```

## Policy engine

The engine is **pure** — no chain dependency, fully unit-testable. Rules
are configured in `policy.config.json`. Every rule runs; the aggregator
returns `block` if any rule blocks, else `escalate` if any rule escalates,
else `allow`. The `reasons` array carries every triggering rule's
explanation for the audit log.

Rule types:

| Rule | Effect |
|---|---|
| `perTransactionCap` | Reject amounts above ceiling |
| `rollingWindow` | Total spend in window must stay under limit |
| `velocityLimit` | Max payment count in window |
| `allowlist` / `denylist` | Recipient / creator code permitted? |
| `approvalThreshold` | Above this → `escalate` (HITL), not `block` |
| `conditionalGate` | Require a matching verified conversion |
| `idempotency` | Already-paid `orderId` → `block` |

Example `policy.config.json` ships in this repo; see
[`docs/POLICY.md`](docs/POLICY.md) for the full schema.

## Demo scenarios

Mirrors the 5 cases from the build brief §9. Each produces a readable CLI
trace and a corresponding audit entry on HCS:

1. Happy path — verified conversion, all caps clear → auto-pay
2. Rolling cap hit — `block` (rolling window)
3. Unverified / not allowlisted — `block` (conditional gate / allowlist)
4. Over threshold — `escalate` → HITL → on "yes" pay
5. Duplicate — re-run a paid `orderId` → `block` (idempotency)

## Atlas portfolio framing

This repo is the **policy-payments primitive** Atlas reuses across its
ventures. For the bounty it ships standalone with a JSON rule config and a
CLI demo. The productization path is:

1. Replace seeded conversions with a live Shopify attribution feed.
2. Move rules from JSON → Supabase; add a configuration UI.
3. Add FX (order currency → payout currency) and USDC support.
4. Ship as an Atlas Growth Engine add-on for DTC clients (first dogfood:
   VICE creator payouts).

None of that is in scope for the bounty submission.

## Licence

MIT — see [`LICENSE`](LICENSE).
