import type { Rule } from '../types.js';
import { tinybarToHbar } from '../types.js';

// Approval threshold differs from per-transaction cap: above the threshold the rule
// ESCALATES (→ HITL) rather than blocking outright. The aggregator's precedence
// (block > escalate > allow) ensures another rule's block still wins.

export const approvalThreshold: Rule = (payment, _state, config) => {
  const cfg = config.approvalThreshold;
  if (!cfg) return null;
  if (payment.amount > cfg.amount) {
    return {
      rule: 'approvalThreshold',
      decision: 'escalate',
      reason: `amount ${tinybarToHbar(payment.amount)} HBAR is above approval threshold ${tinybarToHbar(cfg.amount)} HBAR — requires human approval`,
    };
  }
  return { rule: 'approvalThreshold', decision: 'allow' };
};
