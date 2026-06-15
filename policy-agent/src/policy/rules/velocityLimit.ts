import type { Rule } from '../types.js';

const HOUR_MS = 3_600_000;

export const velocityLimit: Rule = (_payment, state, config) => {
  const cfg = config.velocityLimit;
  if (!cfg) return null;

  const windowStart = state.now - cfg.windowHours * HOUR_MS;
  let count = 0;
  for (const r of state.recentPayments) {
    if (r.occurredAt < windowStart) continue;
    if (r.decision !== 'allow') continue;
    count++;
  }

  if (count + 1 > cfg.maxPayments) {
    return {
      rule: 'velocityLimit',
      decision: 'block',
      reason: `velocity limit ${cfg.maxPayments} payments/${cfg.windowHours}h would be breached: ${count} already in window`,
    };
  }
  return { rule: 'velocityLimit', decision: 'allow' };
};
