// Aging bucket logic — pure mirror of the SQL `age_bucket` + `overdue_days` functions
// (0015, reworked in 0020). Parity between the two sides is enforced in CI by
// scripts/sql-ts-parity.ts. Bands match the statement schema (statements.aging_current /
// aging_30 / aging_60 / aging_90 / aging_90_plus, all in cents).

export type AgingBucket = 'current' | '30' | '60' | '90' | '90_plus';

/** The platform default; NZ business. Callers may override per-org later. */
export const DEFAULT_TIMEZONE = 'Pacific/Auckland';

/**
 * Bucket an integer day count of overdue-ness. Negative or zero days = current
 * (not yet overdue). '90_plus' is genuinely more than 90 days since 0020.
 */
export function ageBucket(overdueDays: number): AgingBucket {
  if (overdueDays <= 0) return 'current';
  if (overdueDays <= 30) return '30';
  if (overdueDays <= 60) return '60';
  if (overdueDays <= 90) return '90';
  return '90_plus';
}

/**
 * Calendar day number of an instant in a timezone (days since the Unix epoch, counted
 * on that timezone's calendar).
 */
function calendarDayNumber(instant: Date, timeZone: string): number {
  // en-CA formats as YYYY-MM-DD.
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(instant);
  const [y, m, d] = parts.split('-').map(Number);
  if (y === undefined || m === undefined || d === undefined || Number.isNaN(y)) {
    throw new Error(`overdueDays: unparseable date parts '${parts}'`);
  }
  return Date.UTC(y, m - 1, d) / 86_400_000;
}

/**
 * Integer overdue days from an anchor (due/issued date) to as-of — CALENDAR days in the
 * given timezone, mirroring SQL `overdue_days` (0020):
 *   (as_of at time zone tz)::date - (anchor at time zone tz)::date
 * Calendar-day counting is DST-immune: "31 days overdue" is a fact about dates on the
 * NZ calendar, not about elapsed 86400-second windows in UTC (which drift an hour at
 * every DST transition and disagree near midnight). Negative results are preserved so
 * callers can distinguish "due tomorrow" (-1) from "due today" (0).
 */
export function overdueDays(
  anchor: Date,
  asOf: Date,
  timeZone: string = DEFAULT_TIMEZONE,
): number {
  return calendarDayNumber(asOf, timeZone) - calendarDayNumber(anchor, timeZone);
}
