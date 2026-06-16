import type {
  Decision,
  PolicyInput,
  PolicyState,
  Rule,
  RuleConfig,
  RuleResult,
} from './types.js';
import { perTransactionCap } from './rules/perTransactionCap.js';
import { rollingWindow } from './rules/rollingWindow.js';
import { velocityLimit } from './rules/velocityLimit.js';
import { allowlist } from './rules/allowlist.js';
import { denylist } from './rules/denylist.js';
import { approvalThreshold } from './rules/approvalThreshold.js';
import { conditionalGate } from './rules/conditionalGate.js';
import { idempotency } from './rules/idempotency.js';

// Order is irrelevant for correctness (the aggregator handles precedence), but stable
// ordering makes the reasons array deterministic for the audit log.
const RULES: Rule[] = [
  idempotency,
  allowlist,
  denylist,
  perTransactionCap,
  rollingWindow,
  velocityLimit,
  conditionalGate,
  approvalThreshold,
];

/**
 * Evaluate a proposed action against the rule set.
 *
 * Precedence: `block` > `escalate` > `allow`. The `reasons` array carries the
 * explanation from every rule that contributed to the final decision (every blocking
 * rule when blocked, every escalating rule when escalated, or a single informational
 * line when allowed).
 */
export function evaluate(
  input: PolicyInput,
  state: PolicyState,
  config: RuleConfig,
): Decision {
  const results: RuleResult[] = [];
  for (const rule of RULES) {
    const r = rule(input, state, config);
    if (r) results.push(r);
  }

  const blocking = results.filter((r) => r.decision === 'block');
  if (blocking.length > 0) {
    return {
      decision: 'block',
      reasons: blocking.map((r) => `[${r.rule}] ${r.reason ?? ''}`.trim()),
    };
  }

  const escalating = results.filter((r) => r.decision === 'escalate');
  if (escalating.length > 0) {
    return {
      decision: 'escalate',
      reasons: escalating.map((r) => `[${r.rule}] ${r.reason ?? ''}`.trim()),
    };
  }

  return {
    decision: 'allow',
    reasons: results.length > 0
      ? ['all configured rules cleared']
      : ['no rules configured; default-allow'],
  };
}
