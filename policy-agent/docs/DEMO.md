# Demo Script

The recorded ~2-min demo follows this script. Total runtime ~2 minutes
including narration.

## Pre-flight (off-camera)

```bash
# 0a. Hedera testnet account created at https://portal.hedera.com/dashboard
# 0b. .env populated
cp .env.example .env
$EDITOR .env   # paste HEDERA_OPERATOR_ID, HEDERA_OPERATOR_KEY,
               # ANTHROPIC_API_KEY, DEMO_RECIPIENT_ID

# 0c. install
npm install

# 0d. confirm the rail (optional — proves the testnet works)
npm run hedera:hello
# → prints HashScan URL of a 1 HBAR transfer

# 0e. create HCS topics + seed verified conversions
npm run hedera:topics
npm run demo:seed
```

## On-camera (~2 min)

### Open with the problem statement (~10s)

> "AI agents that move money have a structural safety problem. We
> built a policy-constrained payment agent on Hedera. The policy
> engine sits between the LLM and the Hedera Agent Kit — a `block`
> decision can't reach the chain because the LLM has no path to a
> raw transfer tool."

### Walk through the wrapped payment tool (~20s)

```bash
$EDITOR src/agent/tools/payCreator.ts
```

> "This is the only file in `src/` that calls `transferHbar`. The
> interception test enforces that statically. The LLM only ever sees
> `pay_creator` — a tool that always runs the policy engine first."

### Run all 5 demo scenarios (~60s)

```bash
npm run demo
```

Narration over the output:

- **Scenario 1** — verified conversion, all caps clear → `allow` → real
  testnet HBAR transfer. Show the HashScan URL.
- **Scenario 2** — verified conversion that would breach the 500 HBAR /
  168h rolling cap → `block`. Note: no transfer; audit message recorded.
- **Scenario 3** — payout requested for creator not on the allowlist →
  `block`. Note: structural rejection; the LLM can't bypass.
- **Scenario 4** — verified conversion above the 50 HBAR approval
  threshold → `escalate` → CLI HITL prompt. Type `y` → transfer happens.
- **Scenario 5** — re-run scenario 1's already-paid orderId → `block`
  (idempotency). This is what stops a naive agent from double-paying
  on a retry.

### Show the audit topic on the mirror node (~20s)

```bash
# Either via the mirror node REST API:
curl -s "https://testnet.mirrornode.hedera.com/api/v1/topics/$HCS_AUDIT_TOPIC_ID/messages?limit=10&order=desc" \
  | jq '.messages[] | (.message | @base64d | fromjson) as $m | {seq: .sequence_number, decision: $m.decision, reasons: $m.reasons}'

# Or via HashScan: https://hashscan.io/testnet/topic/<HCS_AUDIT_TOPIC_ID>
```

> "Every decision and every receipt is on HCS. The same Hedera
> primitive carries both the trigger for a payout — the verified
> conversion — and the immutable record of the payout decision."

### Close (~10s)

> "Built on the Hedera Agent Kit. Public repo:
> github.com/toddilis/atlas-policy-agent. Feedback issue linked in
> the description."

## Recording tips

- Run the demo once dry to make sure the HCS topics + seeded
  conversions are present; the demo reads them via the testnet
  mirror node so allow ~5-10s of indexing lag between
  `demo:seed` and `demo`.
- Use a terminal with a readable monospace font and a dark theme.
- Capture at 1080p or higher; the HashScan URLs need to be legible.
- The HITL prompt in scenario 4 pauses for input — pre-plan the
  `y` press so the recording doesn't drift past 2 min.
