import type { Rule } from '../types.js';

export const allowlist: Rule = (input, _state, config) => {
  const cfg = config.allowlist;
  if (!cfg) return null;
  const value = input.attributes[cfg.attribute];
  if (value === undefined || value === null) {
    return {
      rule: 'allowlist',
      decision: 'block',
      reason: `allowlist requires attribute "${cfg.attribute}" but it was not provided`,
    };
  }
  if (cfg.values.includes(value as string | number)) {
    return { rule: 'allowlist', decision: 'allow' };
  }
  return {
    rule: 'allowlist',
    decision: 'block',
    reason: `attribute "${cfg.attribute}"="${String(value)}" is not on the allowlist`,
  };
};
