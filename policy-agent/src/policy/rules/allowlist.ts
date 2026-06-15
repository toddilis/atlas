import type { Rule } from '../types.js';

// Allowlist entries can be raw account ids ('0.0.1234') OR creator codes prefixed with
// 'creator-code:' (e.g. 'creator-code:ABC'). A payment is allowed if EITHER its recipient
// id OR its creator code (in prefixed form) is in the allowlist. When `allowlist` is not
// configured, the rule is a no-op.

export const allowlist: Rule = (payment, _state, config) => {
  const cfg = config.allowlist;
  if (!cfg) return null;

  const codeKey = `creator-code:${payment.creatorCode}`;
  const entries = cfg.entries;
  if (entries.includes(payment.recipient) || entries.includes(codeKey)) {
    return { rule: 'allowlist', decision: 'allow' };
  }
  return {
    rule: 'allowlist',
    decision: 'block',
    reason: `recipient ${payment.recipient} (creator ${payment.creatorCode}) is not on the allowlist`,
  };
};
