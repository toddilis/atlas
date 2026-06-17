// Invoice browser — list view. Filter by state via querystring (?state=issued).
// Newest issued first; drafts sorted by created_at when not yet issued.

import Link from 'next/link';
import { supabaseServer, orgId } from '@/lib/supabase';
import { formatCents, formatDate } from '@/lib/format';
import { Badge, invoiceStateTone } from '@/components/Badge';

export const dynamic = 'force-dynamic';

const INVOICE_STATES = ['all', 'draft', 'issued', 'partial', 'paid', 'void'] as const;
type InvoiceStateFilter = (typeof INVOICE_STATES)[number];

interface InvoiceRow {
  id: string;
  invoice_number: string;
  state: string;
  channel: string;
  currency: string;
  total_cents: number;
  issued_at: string | null;
  paid_at: string | null;
  created_at: string;
  account: { name: string } | null;
}

async function loadInvoices(state: InvoiceStateFilter): Promise<InvoiceRow[]> {
  const sb = supabaseServer();
  let q = sb
    .from('invoices')
    .select(
      'id, invoice_number, state, channel, currency, total_cents, issued_at, paid_at, created_at, account:accounts(name)',
    )
    .eq('org_id', orgId())
    .order('issued_at', { ascending: false, nullsFirst: false })
    .order('created_at', { ascending: false })
    .limit(200);
  if (state !== 'all') {
    q = q.eq('state', state);
  }
  const { data, error } = await q;
  if (error) throw error;
  return ((data as unknown) as InvoiceRow[]) ?? [];
}

export default async function InvoicesPage({
  searchParams,
}: {
  searchParams: { state?: string };
}) {
  const requested = (searchParams.state ?? 'all') as InvoiceStateFilter;
  const filter: InvoiceStateFilter = INVOICE_STATES.includes(requested)
    ? requested
    : 'all';
  const rows = await loadInvoices(filter);

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Invoices</h1>
        <div className="text-sm text-zinc-500">
          {rows.length} {rows.length === 1 ? 'invoice' : 'invoices'}
        </div>
      </div>

      <FilterBar current={filter} />

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center text-zinc-500">
          No invoices match this filter.
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Number</th>
                <th className="text-left px-4 py-2 font-medium">Account</th>
                <th className="text-left px-4 py-2 font-medium">State</th>
                <th className="text-left px-4 py-2 font-medium">Issued</th>
                <th className="text-right px-4 py-2 font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/60">
                  <td className="px-4 py-2 font-mono">
                    <Link href={`/invoices/${row.id}`} className="hover:underline">
                      {row.invoice_number}
                    </Link>
                  </td>
                  <td className="px-4 py-2">{row.account?.name ?? '—'}</td>
                  <td className="px-4 py-2">
                    <Badge tone={invoiceStateTone(row.state)}>{row.state}</Badge>
                  </td>
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                    {formatDate(row.issued_at)}
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {formatCents(row.total_cents, row.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function FilterBar({ current }: { current: InvoiceStateFilter }) {
  return (
    <div className="flex flex-wrap gap-2 text-sm">
      {INVOICE_STATES.map((s) => {
        const active = s === current;
        const href = s === 'all' ? '/invoices' : `/invoices?state=${s}`;
        return (
          <Link
            key={s}
            href={href}
            className={`px-3 py-1 rounded-full border transition ${
              active
                ? 'border-zinc-900 dark:border-zinc-100 bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900'
                : 'border-zinc-200 dark:border-zinc-800 hover:border-zinc-400'
            }`}
          >
            {s}
          </Link>
        );
      })}
    </div>
  );
}
