// GST / tax computation — mirrors the SQL helper `compute_gst_cents` in
// migration 0014 so a Phase 2 preview UI (or any TS-side reconciliation) computes the
// same value as the canonical SQL function used by draft_invoice_atomic. Parity between
// the two is enforced in CI by scripts/sql-ts-parity.ts.
//
// Semantics: floor (integer truncation). Matches Postgres integer division for
// non-negative inputs. NZ IRD accepts consistent rounding; floor is conservative
// (under-charges by up to 1 cent rather than over-charging).
//
// Precision (PR-N): the multiply runs in BigInt, so the result is exact for every
// representable integer input — subtotal × rate above 2^53 no longer silently loses
// precision where SQL bigint does not. Results beyond Number.MAX_SAFE_INTEGER throw
// rather than return an approximation.

export interface TaxConfig {
  /** Org-wide rate in basis points. 1500 = 15%. 0 disables tax. */
  rateBps: number;
  /** When true, this account is zero-rated regardless of org rate. */
  exempt: boolean;
}

/**
 * Compute GST in minor units. Pure function. Inputs must be non-negative integers
 * (asserted, matching the SQL function's raise exception).
 */
export function computeGstCents(subtotalCents: number, config: TaxConfig): number {
  if (!Number.isInteger(subtotalCents) || !Number.isInteger(config.rateBps)) {
    throw new Error('computeGstCents: inputs must be integers');
  }
  if (subtotalCents < 0 || config.rateBps < 0) {
    throw new Error('computeGstCents: inputs must be non-negative');
  }
  if (config.exempt || config.rateBps === 0) return 0;
  const gst = (BigInt(subtotalCents) * BigInt(config.rateBps)) / 10000n;
  if (gst > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error('computeGstCents: result exceeds Number.MAX_SAFE_INTEGER');
  }
  return Number(gst);
}
