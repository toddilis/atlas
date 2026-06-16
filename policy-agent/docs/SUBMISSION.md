# Submission Form — Hedera AI Agent Bounty Week 5

Draft answers for the official submission form. Paste into each field;
adjust the bracketed placeholders before final submission.

---

## Project name

**Atlas Policy Agent**

## One-line / Two-line description

A policy-constrained AI payment agent on Hedera: a deterministic policy
engine sits between an LLM and the Hedera Agent Kit, gating every payout
against a configurable rule set, with every decision and receipt recorded
immutably on HCS.

## Project summary (1–3 paragraphs)

Atlas Policy Agent is a structural answer to the "AI agents can't be
trusted with money" problem. An LLM agent receives a natural-language
payout intent ("pay creator ABC their commission on order 1042"); before
any HBAR moves, a pure deterministic **policy engine** evaluates the
proposed payment against a rule set and returns `allow`, `block`, or
`escalate`. Only on `allow` does the agent execute an on-chain transfer
via the Hedera Agent Kit. Every decision and every receipt is written
immutably to the Hedera Consensus Service.

The bounty's "cannot drain funds without consent" safety requirement is
satisfied **structurally**, not by prompt discipline. The Hedera SDK's
`transferHbar` is wrapped in a single payment tool that runs the policy
engine first; a static test enforces that no other file in the codebase
can call the raw transfer. The LLM has no path — hallucinated, jailbroken,
or otherwise — to a payment that hasn't been approved by the policy.

The demo packages this as **conversion-gated creator payouts**: a payout
is gated on a verified attribution event recorded on HCS, so the agent
only pays when the conversion is real, the amount is within terms, and
the order hasn't already been paid. HCS does double duty — it stores the
trigger (verified conversions) AND the immutable audit trail. The same
Hedera-native primitive that authorises a payment also records that it
happened.

## Repository URL

https://github.com/toddilis/atlas-policy-agent

(Public; CI green; ~24 unit tests covering every policy rule + the
static interception invariant.)

## Demo URL

[YOUTUBE OR LOOM URL — paste after recording]

## Payout wallet address

**Account ID:** [PASTE OPERATOR ID OR DEDICATED PAYOUT ACCOUNT —
0.0.xxxxxxx on Hedera mainnet, since the bounty pays out in mainnet HBAR.
If you don't have a mainnet account yet, create one at portal.hedera.com
and supply that id.]

## Implementation details (how the Agent Kit / plugins / HCS were used)

- **Hedera Agent Kit JS v3.8.2** — LangChain integration. Built a single
  wrapped payment tool (`pay_creator`) exposed to the agent through
  `createReactAgent`; the kit's built-in transfer is invoked from inside
  the wrapper *only* after the policy engine returns `allow`.
- **`@hashgraph/sdk` 2.x** — direct use for `TransferTransaction` (operator
  → recipient), `TopicCreateTransaction` (audit + conversions topics),
  and `TopicMessageSubmitTransaction` (decisions + receipts).
- **HCS — Conversions topic**: seeded with verified attribution events
  (`{type:'conversion', creatorCode, orderId, commission, orderValue,
  verifiedAt, status:'verified'}`). The conditional-gate rule queries
  this topic via the testnet mirror node before allowing any payout.
- **HCS — Audit topic**: every policy decision (`allow` / `block` /
  `escalate`, with the array of triggering rules) and every transfer
  receipt (with the on-chain tx id) is written here as JSON. The agent's
  `readState()` rebuilds policy state — recent payments, paid order ids
  — by querying this topic on every decision.
- **Claude (Sonnet 4.6) via `@langchain/anthropic`** — the agent runtime.
  Claude reads the natural-language intent, extracts the four payment
  parameters, and invokes the wrapped payment tool. It has no other
  payment-capable tool, so a `block` from the policy engine is structurally
  unavoidable.

## Feedback issue

[GITHUB ISSUE URL after filing — see `docs/FEEDBACK_ISSUE.md` for the
drafted body; file it on
https://github.com/hashgraph/hedera-agent-kit-js/issues/new]

## Test plan / safety

- 24 unit tests under `npm test`: every policy rule, the aggregator's
  `block > escalate > allow` precedence, the empty-config edge case, and
  the static interception invariant.
- The static interception test (`test/interception.test.ts`) walks the
  entire `src/` tree on every CI run and fails the build if any file
  outside the wrapped payment tool references `transferHbar`. This is
  the structural enforcement of the "cannot drain funds" safety rule.
- Five end-to-end scenarios (`npm run demo`) covering happy path,
  approval-threshold escalation with HITL confirmation, rolling-window
  cap blocking, allowlist blocking, and idempotency (double-pay
  prevention). Each produces a CLI trace + an HCS audit message.
- Testnet only; no mainnet code paths in scope.

## Single entry confirmation

Yes — this is my single Week 5 entry.

## T&Cs

Accepted.
