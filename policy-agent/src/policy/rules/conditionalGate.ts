import type { Rule } from '../types.js';
import { tinybarToHbar } from '../types.js';

// The conditional gate is the heart of "conversion-gated payouts": the payment requires
// a matching verified conversion in state.verifiedConversions, the requested amount must
// match the conversion's commission (within optional tolerance), and the implied commission
// rate (commission / orderValue) must be at or below maxCommissionRate.

export const conditionalGate: Rule = (payment, state, config) => {
  const cfg = config.conditionalGate;
  if (!cfg || !cfg.requireVerifiedConversion) return null;

  const match = state.verifiedConversions.find(
    (c) =>
      c.creatorCode === payment.creatorCode &&
      c.orderId === payment.orderId &&
      c.status === 'verified',
  );

  if (!match) {
    return {
      rule: 'conditionalGate',
      decision: 'block',
      reason: `no verified conversion found for creator ${payment.creatorCode} on order ${payment.orderId}`,
    };
  }

  const tolerance = cfg.amountTolerance ?? 0n;
  const diff = payment.amount - match.commission;
  const absDiff = diff < 0n ? -diff : diff;
  if (absDiff > tolerance) {
    return {
      rule: 'conditionalGate',
      decision: 'block',
      reason: `requested amount ${tinybarToHbar(payment.amount)} HBAR does not match verified commission ${tinybarToHbar(match.commission)} HBAR (tolerance ${tinybarToHbar(tolerance)})`,
    };
  }

  // commission rate = commission / orderValue. Compare using integer math:
  // commission * 10000 vs orderValue * floor(rate * 10000)
  if (match.orderValue > 0n) {
    const rateBp = Math.round(cfg.maxCommissionRate * 10_000);   // basis-points-like
    const lhs = match.commission * 10_000n;
    const rhs = match.orderValue * BigInt(rateBp);
    if (lhs > rhs) {
      const observedPct = (Number(match.commission) / Number(match.orderValue)) * 100;
      return {
        rule: 'conditionalGate',
        decision: 'block',
        reason: `commission rate ${observedPct.toFixed(2)}% exceeds max ${(cfg.maxCommissionRate * 100).toFixed(2)}%`,
      };
    }
  }

  return { rule: 'conditionalGate', decision: 'allow' };
};
