import type { Rule } from '../types.js';
import { toMajor } from '../types.js';

export const perTransactionCap: Rule = (input, _state, config) => {
  const cfg = config.perTransactionCap;
  if (!cfg) return null;
  if (input.amount > cfg.amount) {
    return {
      rule: 'perTransactionCap',
      decision: 'block',
      reason: `amount ${toMajor(input.amount)} ${input.currency} exceeds per-transaction cap ${toMajor(cfg.amount)} ${input.currency}`,
    };
  }
  return { rule: 'perTransactionCap', decision: 'allow' };
};
