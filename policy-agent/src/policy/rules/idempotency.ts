import type { Rule } from '../types.js';

// Idempotency is on by default. A toggle exists for tests + edge cases (e.g. intentional
// re-issue after a manual void). In production this is treated as a first-class rule, not
// an afterthought, because re-runs of the same intent are the most common way a naive
// agent would double-pay.

export const idempotency: Rule = (payment, state, config) => {
  const enabled = config.idempotency?.enabled ?? true;
  if (!enabled) return null;

  if (state.paidOrderIds.has(payment.orderId)) {
    return {
      rule: 'idempotency',
      decision: 'block',
      reason: `order ${payment.orderId} has already been paid`,
    };
  }
  return { rule: 'idempotency', decision: 'allow' };
};
