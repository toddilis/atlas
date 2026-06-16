// Aging bucket logic — pure mirror of the SQL `age_bucket` function in 0015. Used by
// Phase 2 preview UIs and any TS-side AR analysis. Bands match the statement schema
// (statements.aging_current_cents / aging_30_cents / aging_60_cents / aging_90_plus_cents).
//
// Convention note: the outer bucket is called '90_plus' for operator readability even
// though the cutoff is 60 days, not 90. This matches industry conventions for AR aging
// reports where the bucket label is the lower edge of the next band.

export type AgingBucket = 'current' | '30' | '60' | '90_plus';

/**
 * Bucket an integer day count of overdue-ness. Negative or zero days = current
 * (not yet overdue).
 */
export function ageBucket(overdueDays: number): AgingBucket {
  if (overdueDays <= 0) return 'current';
  if (overdueDays <= 30) return '30';
  if (overdueDays <= 60) return '60';
  return '90_plus';
}

/**
 * Compute integer overdue days from a due / issued date to as_of. Uses calendar-day
 * arithmetic via `Math.floor((as_of - anchor) / day)`. Negative result is clamped to 0
 * by the caller via ageBucket — this function preserves the sign for callers that want
 * to distinguish "due tomorrow" (-1) from "due today" (0).
 */
export function overdueDays(anchor: Date, asOf: Date): number {
  const DAY_MS = 86_400_000;
  return Math.floor((asOf.getTime() - anchor.getTime()) / DAY_MS);
}
