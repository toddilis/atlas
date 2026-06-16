import type { Rule } from '../types.js';
import { toMajor } from '../types.js';

// approvalThreshold escalates (→ HITL) rather than blocking outright. The aggregator's
// precedence (block > escalate > allow) ensures any other rule's block still wins.

export const approvalThreshold: Rule = (input, _state, config) => {
  const cfg = config.approvalThreshold;
  if (!cfg) return null;
  if (input.amount > cfg.amount) {
    return {
      rule: 'approvalThreshold',
      decision: 'escalate',
      reason: `amount ${toMajor(input.amount)} ${input.currency} is above approval threshold ${toMajor(cfg.amount)} ${input.currency} — requires human approval`,
    };
  }
  return { rule: 'approvalThreshold', decision: 'allow' };
};
