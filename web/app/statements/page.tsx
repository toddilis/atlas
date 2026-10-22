// Statement list — newest as_of_at first. Drill into any row for the preview, and
// generate a new one here (0044): the database enforces the grant, pause, bounds and
// the derivation; aging runs in the business's own calendar (the active pricing
// configuration's timezone).

import Link from 'next/link';
import { supabaseServer, orgId } from '@/lib/supabase';
import { formatCents, formatDate } from '@/lib/format';
import { Badge, statementStateTone } from '@/components/Badge';
import { STATEMENT_OUTCOMES, isStatementOutcome } from '@/lib/statements';

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
  const sb = await supabaseServer();
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

async function loadGenerateState() {
  const sb = await supabaseServer();
  const org = orgId();
  const [accounts, grants, controls] = await Promise.all([
    sb.from('accounts').select('id, name').eq('org_id', org).order('name').limit(500),
    sb.from('tool_grants').select('enabled').eq('org_id', org).eq('agent_name', 'operator').eq('tool_name', 'statements.generate'),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
  ]);
  for (const r of [accounts, grants, controls]) if (r.error) throw r.error;
  // Shown so the operator knows before trying; the database enforces both on every run.
  return {
    accounts: (accounts.data ?? []) as Array<{ id: string; name: string }>,
    can: (grants.data ?? []).some(g => g.enabled) && !controls.data?.paused,
  };
}

const field = 'rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm';

export default async function StatementsPage({ searchParams }: { searchParams: Promise<{ outcome?: string }> }) {
  const { outcome } = await searchParams;
  const notice = isStatementOutcome(outcome) ? STATEMENT_OUTCOMES[outcome] : null;
  const [rows, generate] = await Promise.all([loadStatements(), loadGenerateState()]);
  const monthStart = `${new Date().toISOString().slice(0, 7)}-01`;

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Statements</h1>
        <div className="text-sm text-zinc-500">
          {rows.length} {rows.length === 1 ? 'statement' : 'statements'}
        </div>
      </div>

      {notice ? (
        <div data-testid="statement-notice" role="status" className={`rounded-lg border p-4 text-sm ${notice.ok
          ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
          : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'}`}>
          {notice.text}
        </div>
      ) : null}

      {generate.can ? (
        <form method="post" action="/statements/generate" className="flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
          <label className="text-sm">Retailer<br />
            <select name="account_id" aria-label="Statement retailer" required className={field} defaultValue="">
              <option value="" disabled>Choose a retailer</option>
              {generate.accounts.map(a => <option key={a.id} value={a.id}>{a.name}</option>)}
            </select></label>
          <label className="text-sm">Period start<br />
            <input name="period_start" aria-label="Statement period start" type="date" required defaultValue={monthStart} className={field} /></label>
          <label className="text-sm">As of (blank = now)<br />
            <input name="as_of" aria-label="Statement as of" type="date" className={field} /></label>
          <button type="submit" className="rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-3 py-1 text-sm font-medium">
            Generate statement
          </button>
          <span className="pb-1 text-xs text-zinc-500">Derived from the stored records; aging runs in the business&rsquo;s own calendar.</span>
        </form>
      ) : (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 text-sm text-zinc-600 dark:text-zinc-400">
          Statement generation is switched off (the operator statements.generate grant is missing or revoked, or business actions are paused).
        </div>
      )}

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center text-zinc-500">
          No statements generated yet. Generate the first one above.
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
