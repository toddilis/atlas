# Policy Engine Reference

The engine is pure, deterministic, and has zero chain dependency. Every
function in `src/policy/` can be unit-tested without a Hedera account.

## Public contract

```ts
function evaluate(
  payment: Payment,
  state: PolicyState,
  config: RuleConfig,
): Decision;

interface Decision {
  decision: 'allow' | 'block' | 'escalate';
  reasons: string[];
}
```

`reasons` carries the human-readable explanation from every rule that
contributed to the final decision. Empty result + `allow` is replaced by
either `'all configured rules cleared'` (rules ran) or
`'no rules configured; default-allow'` (no rules at all), so the audit log
always has something to write.

## Amount arithmetic

All amounts are **tinybars** (`bigint`). 1 HBAR = 100_000_000 tinybars.
`src/policy/types.ts` exports `hbarToTinybar()` and `tinybarToHbar()` for
conversion at the CLI / config boundary. The engine itself only ever
manipulates tinybars, so the math is exact.

## Rule reference

### `perTransactionCap`

Hard ceiling on a single payment. Block if `payment.amount > cap`.

```json
{ "perTransactionCap": "100" }
```

Decision: **block** when triggered.

### `rollingWindow`

Total spend in a sliding time window must stay under the limit. Only
already-allowed payments count toward the window's total.

```json
{ "rollingWindow": { "amount": "500", "windowHours": 168 } }
```

Decision: **block** when (sum + requested) > amount.

### `velocityLimit`

Maximum number of payments in a sliding time window. Already-allowed
payments count.

```json
{ "velocityLimit": { "maxPayments": 20, "windowHours": 168 } }
```

Decision: **block** when (count + 1) > maxPayments.

### `allowlist` / `denylist`

Recipient account ids and creator codes are checked against the list.
Creator codes are prefixed with `creator-code:`. Entries can mix.

```json
{
  "allowlist": ["creator-code:ABC", "0.0.5001"],
  "denylist": ["creator-code:BAD"]
}
```

Decisions: **block** on allowlist miss; **block** on denylist hit.

### `approvalThreshold`

Different from `perTransactionCap`: above this threshold the rule
**escalates** (→ HITL) rather than blocking outright.

```json
{ "approvalThreshold": "50" }
```

Decision: **escalate** when triggered. Block from another rule still
wins (block > escalate > allow).

### `conditionalGate`

The heart of conversion-gated payouts. Three checks:

1. A verified conversion event must exist with matching `creatorCode +
   orderId` and `status: 'verified'`.
2. The payment amount must equal the conversion's commission (within
   optional `amountTolerance`).
3. The conversion's `commission / orderValue` must be ≤
   `maxCommissionRate`.

```json
{
  "conditionalGate": {
    "requireVerifiedConversion": true,
    "maxCommissionRate": 0.20,
    "amountTolerance": "0"
  }
}
```

Decision: **block** on any failing check.

### `idempotency`

Block already-paid `orderId`. Defaults to **enabled**; the toggle exists
for tests + intentional re-issue scenarios.

```json
{ "idempotency": { "enabled": true } }
```

Decision: **block** when `orderId ∈ state.paidOrderIds`.

## Aggregation

```
decisions = rules.map(r => r.run(payment, state, config))

if any(decision == 'block')     → 'block', concat all block reasons
elif any(decision == 'escalate') → 'escalate', concat all escalate reasons
else                              → 'allow', single informative reason
```

A blocked decision **never** includes escalation reasons, because the
escalation never had a chance to run downstream.

## State shape

```ts
interface PolicyState {
  recentPayments: PaymentRecord[];   // historical allow decisions w/ on-chain receipts
  paidOrderIds: Set<string>;         // derived from recentPayments + offline imports
  verifiedConversions: ConversionEvent[];
  now: number;                       // injected for determinism
}
```

The atlas-policy-agent runtime builds this from two HCS topics — see
`src/agent/tools/readState.ts`.

## Configuration

`policy.config.json` lives at the repo root. The JSON shape is
intentionally human-friendly (HBAR strings, ISO timestamps); the config
loader (`src/policy/config.ts`) parses + validates and converts to the
engine's bigint types.

## Adding a rule

1. Create `src/policy/rules/<myRule>.ts` exporting a `Rule` function.
2. Add it to the `RULES` array in `src/policy/evaluate.ts`.
3. Extend `RuleConfig` in `src/policy/types.ts`.
4. Add the JSON parsing path in `src/policy/config.ts`.
5. Unit test the rule in `test/policy.test.ts`.

Rules are pure: same `(payment, state, config)` always yields the same
`RuleResult`. No I/O. No clock reads (use `state.now`).
