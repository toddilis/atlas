import type { Rule } from '../types.js';
import { toMajor } from '../types.js';

const HOUR_MS = 3_600_000;

export const rollingWindow: Rule = (input, state, config) => {
  const cfg = config.rollingWindow;
  if (!cfg) return null;
  const windowStart = state.now - cfg.windowHours * HOUR_MS;
  let spentInWindow = 0n;
  for (const r of state.recentActions) {
    if (r.occurredAt < windowStart) continue;
    if (r.decision !== 'allow') continue;
    if (r.currency !== input.currency) continue;
    spentInWindow += r.amount;
  }
  if (spentInWindow + input.amount > cfg.amount) {
    return {
      rule: 'rollingWindow',
      decision: 'block',
      reason: `rolling-window cap ${toMajor(cfg.amount)} ${input.currency}/${cfg.windowHours}h would be breached: ${toMajor(spentInWindow)} already spent + ${toMajor(input.amount)} requested`,
    };
  }
  return { rule: 'rollingWindow', decision: 'allow' };
};
