// Statement list — newest as_of_at first. Drill into any row for the preview.

import Link from 'next/link';
import { supabaseServer, orgId } from '@/lib/supabase';
import { formatCents, formatDate } from '@/lib/format';
import { Badge, statementStateTone } from '@/components/Badge';

export const dynamic = 'force-dynamic';

interface StatementRow {
  id: string;
  state: string;
  currency: string;
  period_start_at: string;
  as_of_at: string;
  closing_balance_cents: number;
  generated_at: string;
  account: { name: string } | null;
}

async function loadStatements(): Promise<StatementRow[]> {
  const sb = supabaseServer();
  const { data, error } = await sb
    .from('statements')
    .select(
      'id, state, currency, period_start_at, as_of_at, closing_balance_cents, generated_at, account:accounts(name)',
    )
    .eq('org_id', orgId())
    .order('as_of_at', { ascending: false })
    .limit(200);
  if (error) throw error;
  return ((data as unknown) as StatementRow[]) ?? [];
}

export default async function StatementsPage() {
  const rows = await loadStatements();

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Statements</h1>
        <div className="text-sm text-zinc-500">
          {rows.length} {rows.length === 1 ? 'statement' : 'statements'}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center text-zinc-500">
          No statements generated yet. Run controller.generate_statement to create one.
        </div>
      ) : (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="text-left px-4 py-2 font-medium">Account</th>
                <th className="text-left px-4 py-2 font-medium">Period</th>
                <th className="text-left px-4 py-2 font-medium">State</th>
                <th className="text-right px-4 py-2 font-medium">Closing</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {rows.map((row) => (
                <tr key={row.id} className="hover:bg-zinc-50 dark:hover:bg-zinc-900/60">
                  <td className="px-4 py-2">
                    <Link href={`/statements/${row.id}`} className="hover:underline">
                      {row.account?.name ?? '—'}
                    </Link>
                  </td>
                  <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                    {formatDate(row.period_start_at)} → {formatDate(row.as_of_at)}
                  </td>
                  <td className="px-4 py-2">
                    <Badge tone={statementStateTone(row.state)}>{row.state}</Badge>
                  </td>
                  <td className="px-4 py-2 text-right font-mono">
                    {formatCents(row.closing_balance_cents, row.currency)}
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
