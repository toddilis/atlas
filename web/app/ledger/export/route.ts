// Download a period's ledger as CSV (CLOSE-01d). Read-only over stored rows; the
// operator is verified (session, allowlist, membership) and the business is bound
// server-side. Day bounds are UTC with the end day inclusive — every row carries its
// full timestamps, so no information rests on the day boundary.

import { OperatorAuthError, requireOperator } from '@/lib/auth-server';
import { supabaseServer } from '@/lib/supabase';
import { ledgerCsv, exportPeriod, type LedgerExportRow } from '@/lib/ledger-export';

interface TxnRow {
  id: string; source: string; description: string; occurred_at: string; posted_at: string;
  lines: Array<{ amount_cents: number; currency: string; memo: string | null;
    account: { code: string; display_name: string } | null }> | null;
}

export async function GET(request: Request) {
  let operator: Awaited<ReturnType<typeof requireOperator>>;
  try { operator = await requireOperator(request); }
  catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    return new Response(null, { status: 303, headers: { Location: '/login' } });
  }
  const url = new URL(request.url);
  const from = (url.searchParams.get('from') ?? '').trim();
  const to = (url.searchParams.get('to') ?? '').trim();
  const period = exportPeriod(from, to);
  if (!period) {
    return new Response(null, { status: 303, headers: { Location: '/ledger?outcome=invalid' } });
  }
  const sb = await supabaseServer();
  const { data, error } = await sb
    .from('ledger_transactions')
    .select('id, source, description, occurred_at, posted_at, lines:ledger_lines(amount_cents, currency, memo, account:ledger_accounts(code, display_name))')
    .eq('org_id', operator.orgId)
    .gte('posted_at', period.fromAt)
    .lt('posted_at', period.toBefore)
    .order('posted_at', { ascending: true })
    .order('id', { ascending: true });
  if (error) throw error;

  const rows: LedgerExportRow[] = [];
  for (const t of ((data ?? []) as unknown) as TxnRow[]) {
    for (const l of t.lines ?? []) {
      rows.push({
        posted_at: t.posted_at, occurred_at: t.occurred_at, transaction_id: t.id,
        source: t.source, description: t.description,
        account_code: l.account?.code ?? '', account_name: l.account?.display_name ?? '',
        memo: l.memo, amount_cents: l.amount_cents, currency: l.currency,
      });
    }
  }
  return new Response(ledgerCsv(rows), {
    status: 200,
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="ledger-${from}-to-${to}.csv"`,
      'cache-control': 'no-store',
    },
  });
}
