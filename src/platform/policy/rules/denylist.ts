import type { Rule } from '../types.js';

export const denylist: Rule = (input, _state, config) => {
  const cfg = config.denylist;
  if (!cfg) return null;
  const value = input.attributes[cfg.attribute];
  if (value !== undefined && value !== null && cfg.values.includes(value as string | number)) {
    return {
      rule: 'denylist',
      decision: 'block',
      reason: `attribute "${cfg.attribute}"="${String(value)}" is on the denylist`,
    };
  }
  return { rule: 'denylist', decision: 'allow' };
};
