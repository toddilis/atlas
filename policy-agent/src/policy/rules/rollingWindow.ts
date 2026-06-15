import type { Rule } from '../types.js';
import { tinybarToHbar } from '../types.js';

const HOUR_MS = 3_600_000;

export const rollingWindow: Rule = (payment, state, config) => {
  const cfg = config.rollingWindow;
  if (!cfg) return null;

  const windowStart = state.now - cfg.windowHours * HOUR_MS;
  // Sum amounts of payments that already counted (allow or escalate→allow paths).
  let spentInWindow = 0n;
  for (const r of state.recentPayments) {
    if (r.occurredAt < windowStart) continue;
    if (r.decision !== 'allow') continue;
    spentInWindow += r.payment.amount;
  }

  if (spentInWindow + payment.amount > cfg.amount) {
    return {
      rule: 'rollingWindow',
      decision: 'block',
      reason: `rolling-window cap ${tinybarToHbar(cfg.amount)} HBAR/${cfg.windowHours}h would be breached: ${tinybarToHbar(spentInWindow)} already spent + ${tinybarToHbar(payment.amount)} requested`,
    };
  }
  return { rule: 'rollingWindow', decision: 'allow' };
};
