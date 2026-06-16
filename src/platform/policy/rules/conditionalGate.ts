import type { Rule } from '../types.js';
import { toMajor } from '../types.js';

// The conditional gate is the heart of "verified-before-acting" governance: the action
// requires a matching `Precondition` in state.preconditions, the precondition's amount
// must match input.amount (within optional tolerance), and the precondition must be the
// right kind. For wholesale invoicing the precondition is a 'wholesale_fulfillment' keyed
// by fulfillment_event_id; for creator payouts it's an 'affiliate_conversion' keyed by
// order_id. The rule is currency-agnostic — currency mismatch is also a block.

export const conditionalGate: Rule = (input, state, config) => {
  const cfg = config.conditionalGate;
  if (!cfg || !cfg.requirePrecondition) return null;

  const key = input.attributes[cfg.matchAttribute];
  if (key === undefined || key === null) {
    return {
      rule: 'conditionalGate',
      decision: 'block',
      reason: `conditionalGate requires attribute "${cfg.matchAttribute}" but it was not provided`,
    };
  }

  const match = state.preconditions.find(
    (p) => p.kind === cfg.precondition && p.key === String(key),
  );

  if (!match) {
    return {
      rule: 'conditionalGate',
      decision: 'block',
      reason: `no verified ${cfg.precondition} found for ${cfg.matchAttribute}=${String(key)}`,
    };
  }

  if (match.currency !== input.currency) {
    return {
      rule: 'conditionalGate',
      decision: 'block',
      reason: `currency mismatch with verified ${cfg.precondition}: requested ${input.currency}, expected ${match.currency}`,
    };
  }

  const tolerance = cfg.amountTolerance ?? 0n;
  const diff = input.amount - match.amount;
  const absDiff = diff < 0n ? -diff : diff;
  if (absDiff > tolerance) {
    return {
      rule: 'conditionalGate',
      decision: 'block',
      reason: `requested amount ${toMajor(input.amount)} does not match verified ${cfg.precondition} amount ${toMajor(match.amount)} (tolerance ${toMajor(tolerance)})`,
    };
  }

  return { rule: 'conditionalGate', decision: 'allow' };
};
