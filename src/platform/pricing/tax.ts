// GST / tax computation — mirrors the SQL helper `compute_gst_cents` in
// migration 0014 so a Phase 2 preview UI (or any TS-side reconciliation) computes the
// same value as the canonical SQL function used by draft_invoice_atomic.
//
// Semantics: floor (integer truncation). Matches Postgres integer division for
// non-negative inputs. NZ IRD accepts consistent rounding; floor is conservative
// (under-charges by up to 1 cent rather than over-charging).

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
  if (subtotalCents < 0 || config.rateBps < 0) {
    throw new Error('computeGstCents: inputs must be non-negative');
  }
  if (config.exempt || config.rateBps === 0) return 0;
  return Math.floor((subtotalCents * config.rateBps) / 10000);
}
