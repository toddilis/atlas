import type { Rule } from '../types.js';
import { tinybarToHbar } from '../types.js';

export const perTransactionCap: Rule = (payment, _state, config) => {
  const cfg = config.perTransactionCap;
  if (!cfg) return null;
  if (payment.amount > cfg.amount) {
    return {
      rule: 'perTransactionCap',
      decision: 'block',
      reason: `amount ${tinybarToHbar(payment.amount)} HBAR exceeds per-transaction cap ${tinybarToHbar(cfg.amount)} HBAR`,
    };
  }
  return { rule: 'perTransactionCap', decision: 'allow' };
};
