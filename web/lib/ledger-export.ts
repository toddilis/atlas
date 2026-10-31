// The accounting handoff (CLOSE-01d): a period's ledger as system-neutral CSV. Pure
// serialization over stored rows — deterministic code owns every figure; amounts are
// exact signed decimals derived with BigInt, never floats. One CSV row per ledger line,
// carrying its transaction's identity so any accountant or import tool can group and
// check that each transaction nets to zero.

export interface LedgerExportRow {
  posted_at: string; occurred_at: string; transaction_id: string;
  source: string; description: string;
  account_code: string; account_name: string; memo: string | null;
  amount_cents: number | string; currency: string;
}

export const LEDGER_CSV_HEADER =
  'posted_at,occurred_at,transaction_id,source,description,account_code,account_name,memo,amount,currency';

/** RFC 4180: quote a field when it carries a comma, quote or line break. */
const field = (v: string) => /[",\n\r]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v;

/** Exact signed decimal from minor units (two decimal places, the only scale in use). */
export const centsToDecimal = (cents: number | string): string => {
  const n = BigInt(cents); const abs = n < 0n ? -n : n;
  return `${n < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2, '0')}`;
};

export function ledgerCsv(rows: LedgerExportRow[]): string {
  const lines = rows.map(r => [
    r.posted_at, r.occurred_at, r.transaction_id, r.source, r.description,
    r.account_code, r.account_name, r.memo ?? '', centsToDecimal(r.amount_cents), r.currency,
  ].map(field).join(','));
  return [LEDGER_CSV_HEADER, ...lines].join('\r\n') + '\r\n';
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
/** Validate a UTC-day period; the end day is inclusive. Returns the half-open instant
 * bounds [fromAt, toBefore) or null when the request is not a valid period. */
export function exportPeriod(from: string, to: string): { fromAt: string; toBefore: string } | null {
  if (!DATE.test(from) || !DATE.test(to) || from > to) return null;
  const next = new Date(`${to}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return { fromAt: `${from}T00:00:00Z`, toBefore: next.toISOString() };
}
