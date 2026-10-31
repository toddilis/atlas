// Receivables ageing (CLOSE-01e): what each retailer owes and how late, in the business's
// calendar. Pure, computed from stored invoices and payments at an as-of instant with the
// same day count and buckets statements use (aging.ts, mirrored by the SQL age_bucket and
// overdue_days that sql-ts-parity checks). Generated statements stay the formal record.

import { ageBucket, overdueDays, type AgingBucket } from '../../src/platform/pricing/aging';

export interface OpenInvoiceRow {
  id: string; invoice_number: string; currency: string; total_cents: number; paid_cents: number;
  issued_at: string | null; due_at: string | null; account_id: string | null; account_name: string | null;
}
export interface AgedInvoice extends OpenInvoiceRow {
  outstanding_cents: number; days_overdue: number; bucket: AgingBucket; aged_from: 'due' | 'issued' | 'none';
}
export interface AgeingRow {
  account_id: string | null; account_name: string; currency: string; invoices: number; total_cents: number;
  buckets: Record<AgingBucket, number>;
}

export const BUCKETS: AgingBucket[] = ['current', '30', '60', '90', '90_plus'];
export const BUCKET_LABELS: Record<AgingBucket, string> = {
  current: 'Current', '30': '1–30 days', '60': '31–60 days', '90': '61–90 days', '90_plus': 'Over 90 days',
};
const emptyBuckets = (): Record<AgingBucket, number> => ({ current: 0, '30': 0, '60': 0, '90': 0, '90_plus': 0 });

/** Each open invoice with what is still owed and how late it is: from its due date, or
 * from its issue date when it has none (as statements age it). Paid-off rows drop out. */
export function ageInvoices(rows: OpenInvoiceRow[], asOf: Date, timeZone: string): AgedInvoice[] {
  return rows.map(r => {
    const anchor = r.due_at ?? r.issued_at;
    const days = anchor ? overdueDays(new Date(anchor), asOf, timeZone) : 0;
    return {
      ...r, outstanding_cents: r.total_cents - r.paid_cents, days_overdue: days, bucket: ageBucket(days),
      aged_from: r.due_at ? 'due' as const : r.issued_at ? 'issued' as const : 'none' as const,
    };
  }).filter(r => r.outstanding_cents > 0);
}

/** One row per retailer and currency, largest balance first. Currencies never mix. */
export function ageingByRetailer(aged: AgedInvoice[]): AgeingRow[] {
  const rows = new Map<string, AgeingRow>();
  for (const i of aged) {
    const key = `${i.account_id ?? ''}|${i.currency}`;
    const row = rows.get(key) ?? { account_id: i.account_id, account_name: i.account_name ?? 'No retailer', currency: i.currency,
      invoices: 0, total_cents: 0, buckets: emptyBuckets() };
    row.buckets[i.bucket] += i.outstanding_cents;
    row.total_cents += i.outstanding_cents;
    row.invoices += 1;
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => a.currency.localeCompare(b.currency) || b.total_cents - a.total_cents
    || a.account_name.localeCompare(b.account_name));
}

/** The whole book per currency: outstanding, and how much of it is overdue. */
export function totalsByCurrency(rows: AgeingRow[]) {
  const totals = new Map<string, { currency: string; total_cents: number; overdue_cents: number; buckets: Record<AgingBucket, number> }>();
  for (const r of rows) {
    const t = totals.get(r.currency) ?? { currency: r.currency, total_cents: 0, overdue_cents: 0, buckets: emptyBuckets() };
    t.total_cents += r.total_cents;
    t.overdue_cents += r.total_cents - r.buckets.current;
    for (const b of BUCKETS) t.buckets[b] += r.buckets[b];
    totals.set(r.currency, t);
  }
  return [...totals.values()].sort((a, b) => a.currency.localeCompare(b.currency));
}

/** Overdue invoices, latest first, then largest. */
export const overdueInvoices = (aged: AgedInvoice[]) => aged.filter(i => i.days_overdue > 0)
  .sort((a, b) => b.days_overdue - a.days_overdue || b.outstanding_cents - a.outstanding_cents);
