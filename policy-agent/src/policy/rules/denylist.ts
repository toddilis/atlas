import type { Rule } from '../types.js';

// Denylist is the reverse: present in the denylist (recipient id OR prefixed creator code)
// → block. Absence is an allow.

export const denylist: Rule = (payment, _state, config) => {
  const cfg = config.denylist;
  if (!cfg) return null;

  const codeKey = `creator-code:${payment.creatorCode}`;
  const entries = cfg.entries;
  if (entries.includes(payment.recipient) || entries.includes(codeKey)) {
    return {
      rule: 'denylist',
      decision: 'block',
      reason: `recipient ${payment.recipient} (creator ${payment.creatorCode}) is on the denylist`,
    };
  }
  return { rule: 'denylist', decision: 'allow' };
};
