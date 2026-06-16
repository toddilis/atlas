import type { Rule } from '../types.js';

// Idempotency is on by default — the toggle exists for tests + intentional re-issue
// scenarios. Reads the configured attribute from the input; if that value is already in
// state.completedSubjectKeys, the action has already been performed and is blocked.

export const idempotency: Rule = (input, state, config) => {
  const cfg = config.idempotency;
  if (!cfg || !cfg.enabled) return null;
  const value = input.attributes[cfg.attribute];
  if (value === undefined || value === null) {
    // No idempotency key on the input → can't check; treat as pass (the action has no
    // natural dedup key, so it's the caller's responsibility).
    return { rule: 'idempotency', decision: 'allow' };
  }
  const key = String(value);
  if (state.completedSubjectKeys.has(key)) {
    return {
      rule: 'idempotency',
      decision: 'block',
      reason: `${cfg.attribute}=${key} has already been actioned`,
    };
  }
  return { rule: 'idempotency', decision: 'allow' };
};
