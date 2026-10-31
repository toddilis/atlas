// Receivables (CLOSE-01e) — what each retailer owes and how late, aged in the business's
// calendar from stored due dates as of now. Read-only: computed from the stored invoices
// and payments on each request with the same day count and buckets statements use;
// generated statements stay the formal record.

import Link from 'next/link';
import { supabaseServer, orgId } from '@/lib/supabase';
import { formatCents } from '@/lib/format';
import { businessTimezone } from '@/lib/business-timezone';
import { ageInvoices, ageingByRetailer, BUCKET_LABELS, BUCKETS, overdueInvoices, totalsByCurrency, type OpenInvoiceRow } from '@/lib/receivables';
import { DEFAULT_TIMEZONE } from '../../../src/platform/pricing/aging';

export const dynamic = 'force-dynamic';

async function loadReceivables(asOf: Date) {
  const sb = await supabaseServer();
  const org = orgId();
  const [invoices, timezone] = await Promise.all([
    sb.from('invoices').select('id, invoice_number, currency, total_cents, issued_at, due_at, account_id, account:accounts(name), payments(amount_cents)')
      .eq('org_id', org).in('state', ['issued', 'partial']).limit(2000),
    businessTimezone(org, asOf.toISOString()),
  ]);
  if (invoices.error) throw invoices.error;
  const rows: OpenInvoiceRow[] = ((invoices.data ?? []) as unknown as Array<{
    id: string; invoice_number: string; currency: string; total_cents: number; issued_at: string | null; due_at: string | null;
    account_id: string | null; account: { name: string } | null; payments: Array<{ amount_cents: number }> | null;
  }>).map(i => ({
    id: i.id, invoice_number: i.invoice_number, currency: String(i.currency), total_cents: Number(i.total_cents),
    paid_cents: (i.payments ?? []).reduce((n, p) => n + Number(p.amount_cents), 0),
    issued_at: i.issued_at, due_at: i.due_at, account_id: i.account_id, account_name: i.account?.name ?? null,
  }));
  return { rows, timezone };
}

export default async function ReceivablesPage() {
  const asOf = new Date();
  const { rows, timezone } = await loadReceivables(asOf);
  const zone = timezone ?? DEFAULT_TIMEZONE;
  const aged = ageInvoices(rows, asOf, zone);
  const retailers = ageingByRetailer(aged);
  const totals = totalsByCurrency(retailers);
  const overdue = overdueInvoices(aged);
  const today = new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: zone }).format(asOf);
  const dueDay = (iso: string | null) => iso
    ? new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: zone }).format(new Date(iso)) : '—';

  return (
    <div className="space-y-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Receivables</h1>
        <div className="text-sm text-zinc-500" data-testid="receivables-as-of">
          As of {today}, {zone}{timezone ? '' : ' (default calendar)'}
        </div>
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-3xl">
        What each retailer owes on issued invoices, less what has been paid, and how late it is: calendar days past
        the due date in the business&rsquo;s timezone (invoices without a due date age from their issue date, as
        statements do). Worked out from the stored records each time this page loads; a generated statement stays the
        formal record you send.
      </p>

      {aged.length === 0 ? (
        <div data-testid="receivables-empty" className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center text-zinc-500">
          Nothing outstanding. Issued invoices appear here until they are paid.
        </div>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {totals.map(t => (
              <div key={t.currency} data-testid="receivables-total" className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
                <div className="text-xs text-zinc-500">Outstanding · {t.currency}</div>
                <div className="text-xl font-semibold font-mono">{formatCents(t.total_cents, t.currency)}</div>
                <div className={`text-sm ${t.overdue_cents > 0 ? 'text-red-700 dark:text-red-300' : 'text-zinc-500'}`}>
                  {t.overdue_cents > 0 ? `${formatCents(t.overdue_cents, t.currency)} overdue` : 'None overdue'}
                </div>
              </div>
            ))}
          </div>

          <section className="space-y-3" aria-label="Ageing by retailer">
            <h2 className="text-lg font-semibold">By retailer</h2>
            <table className="w-full text-sm">
              <thead className="text-left text-zinc-500">
                <tr><th className="py-1">Retailer</th><th className="text-right">Invoices</th>
                  {BUCKETS.map(b => <th key={b} className="text-right">{BUCKET_LABELS[b]}</th>)}
                  <th className="text-right">Outstanding</th></tr>
              </thead>
              <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                {retailers.map(r => (
                  <tr key={`${r.account_id}|${r.currency}`} data-testid="ageing-row">
                    <td className="py-1">{r.account_name}</td>
                    <td className="text-right">{r.invoices}</td>
                    {BUCKETS.map(b => (
                      <td key={b} className={`text-right font-mono ${b !== 'current' && r.buckets[b] > 0 ? 'text-red-700 dark:text-red-300' : ''}`}>
                        {r.buckets[b] === 0 ? '—' : formatCents(r.buckets[b], r.currency)}
                      </td>
                    ))}
                    <td className="text-right font-mono font-medium">{formatCents(r.total_cents, r.currency)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>

          <section className="space-y-3" aria-label="Overdue invoices">
            <h2 className="text-lg font-semibold">Overdue invoices</h2>
            {overdue.length === 0 ? (
              <div data-testid="overdue-empty" className="text-sm text-zinc-500">No invoice is overdue.</div>
            ) : (
              <table className="w-full text-sm">
                <thead className="text-left text-zinc-500">
                  <tr><th className="py-1">Invoice</th><th>Retailer</th><th>Due</th><th className="text-right">Days late</th>
                    <th className="text-right">Outstanding</th></tr>
                </thead>
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                  {overdue.map(i => (
                    <tr key={i.id} data-testid="overdue-invoice">
                      <td className="py-1"><Link href={`/invoices/${i.id}`} className="font-mono hover:underline">{i.invoice_number}</Link></td>
                      <td>{i.account_name ?? 'No retailer'}</td>
                      <td>{i.aged_from === 'due' ? dueDay(i.due_at) : <span className="text-zinc-500">No due date; issued {dueDay(i.issued_at)}</span>}</td>
                      <td className="text-right">{i.days_overdue}</td>
                      <td className="text-right font-mono">{formatCents(i.outstanding_cents, i.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        </>
      )}
    </div>
  );
}
