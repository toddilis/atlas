# Feedback Issue — hashgraph/hedera-agent-kit-js

Draft to file at https://github.com/hashgraph/hedera-agent-kit-js/issues/new?template=agent_kit_feedback.yml

---

## Title

Document the "policy-gated tool wrapper" pattern for HITL / spending-limit
agents

## Type

Feature request / documentation enhancement

## Body

While building a policy-constrained payments agent on the Agent Kit for the
Hedera AI Agent Bounty Week 5, the cleanest way I found to satisfy the
bounty's "agent must not drain funds without consent" safety requirement
was to wrap the kit's transfer tool inside a higher-order tool that runs a
deterministic policy check *before* the kit ever executes a transaction.
The wrapped tool is the only payment-shaped tool exposed to the LLM, so a
`block` decision never reaches the chain — there's no in-band path from the
agent's reasoning loop to a raw `transferHbar`.

This pattern feels generally useful (HITL approvals, spending caps, rate
limits, idempotency guards, conditional gates against off-chain state),
but the kit's current docs and examples don't show it. The closest is the
plugin/MCP guidance, which is more about extending capability than
constraining it.

Two concrete asks:

1. **Add an example** to the kit's documentation (and/or
   `awesome-hedera`) of wrapping a built-in tool with a pre-call policy
   gate. The example should make clear that:
   - The wrapped tool replaces, not augments, the underlying tool in the
     LLM's tool registry — otherwise the LLM can call around it.
   - The policy callback receives the proposed arguments and returns
     `allow` / `block` / `escalate`.
   - On `escalate`, a HITL callback resolves before any on-chain call.
   - Every decision (including blocks) and every executed receipt is
     written to HCS for auditability.
2. **Consider a first-class policy hook** on the kit's `Plugin` /
   `LangchainTool` types — something like `before(args, ctx)` that can
   return `{decision: 'allow' | 'block' | 'escalate', reasons: string[]}`.
   This would push the structural safety property into the kit itself
   rather than relying on every integrator to remember the pattern.

For reference, the implementation I landed on is at
[toddilis/atlas-policy-agent](https://github.com/toddilis/atlas-policy-agent)
(`src/agent/tools/payCreator.ts` is the wrapper, `test/interception.test.ts`
is the static check that enforces the boundary across the repo).

Happy to PR a docs example along these lines if it would be useful.

## Why this matters

- Week 5 of the bounty explicitly asks for policy-constrained agents; this
  pattern is the most defensible way I've found to meet the requirement.
- Without docs, future bounty entrants will either rediscover this pattern,
  or — more likely — try to enforce safety via prompt discipline, which
  fails the moment the LLM is tricked or jailbroken.
- A first-class hook in the kit would also benefit non-bounty users (custodial
  treasuries, automated payouts, etc.).
