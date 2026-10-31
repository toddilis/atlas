// The ledger page (CLOSE-01d): the business's journal, read-only, with the period CSV
// export for the accounting handoff. Deterministic rows only — every figure comes from
// ledger_transactions/ledger_lines exactly as posted.

import { supabaseServer, orgId } from '@/lib/supabase';
import { formatCents, formatDateTime } from '@/lib/format';

export const dynamic = 'force-dynamic';

interface TxnRow {
  id: string; source: string; description: string; posted_at: string;
  lines: Array<{ amount_cents: number; currency: string; memo: string | null;
    account: { code: string; display_name: string } | null }> | null;
}

async function loadRecent(): Promise<TxnRow[]> {
  const sb = await supabaseServer();
  const { data, error } = await sb
    .from('ledger_transactions')
    .select('id, source, description, posted_at, lines:ledger_lines(amount_cents, currency, memo, account:ledger_accounts(code, display_name))')
    .eq('org_id', orgId())
    .order('posted_at', { ascending: false })
    .order('id', { ascending: true })
    .limit(20);
  if (error) throw error;
  return ((data ?? []) as unknown) as TxnRow[];
}

const field = 'mt-1 block rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-sm';

export default async function LedgerPage({ searchParams }: { searchParams: Promise<{ outcome?: string }> }) {
  const { outcome } = await searchParams;
  const txns = await loadRecent();
  const today = new Date().toISOString().slice(0, 10);
  const monthStart = `${today.slice(0, 7)}-01`;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Ledger</h1>
        <div className="text-sm text-zinc-500">most recent {txns.length} transactions</div>
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-3xl">
        Every posting, exactly as recorded: issues, payments, voids and corrections. The export
        is one CSV row per ledger line with exact signed decimals &mdash; the period runs in UTC
        days with the end day inclusive, and each row carries its full timestamps.
      </p>

      {outcome === 'invalid' ? (
        <div data-testid="ledger-notice" role="status" className="rounded-lg border p-4 text-sm border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200">
          Check the period: two dates, with the start on or before the end. Nothing was exported.
        </div>
      ) : null}

      <form method="get" action="/ledger/export" className="flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
        <label className="text-sm">From<br />
          <input name="from" aria-label="Export from" type="date" required defaultValue={monthStart} className={field} /></label>
        <label className="text-sm">To (inclusive)<br />
          <input name="to" aria-label="Export to" type="date" required defaultValue={today} className={field} /></label>
        <button type="submit" className="rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-3 py-1 text-sm font-medium">
          Export CSV
        </button>
        <span className="pb-1 text-xs text-zinc-500">For your accountant; a system-specific format can follow once one is named.</span>
      </form>

      {txns.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center text-zinc-500">
          Nothing posted yet. Postings appear when invoices are issued, paid or voided.
        </div>
      ) : (
        <div className="space-y-3">
          {txns.map((t) => (
            <div key={t.id} data-testid="ledger-txn" className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
              <div className="flex items-baseline justify-between gap-4 flex-wrap">
                <div className="text-sm font-medium">{t.description}</div>
                <div className="text-xs text-zinc-500">{t.source} · {formatDateTime(t.posted_at)}</div>
              </div>
              <table className="w-full text-sm mt-2">
                <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
                  {(t.lines ?? []).map((l, i) => (
                    <tr key={i}>
                      <td className="py-1 text-zinc-600 dark:text-zinc-400">{l.account?.code} {l.account?.display_name}</td>
                      <td className="py-1 text-zinc-500">{l.memo}</td>
                      <td className="py-1 text-right font-mono">{formatCents(l.amount_cents, l.currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
