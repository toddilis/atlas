// Statement preview — the customer-facing rendering of one statement snapshot. Header
// with totals + aging, then line-by-line with running balance. This is what the operator
// reviews before the (later) "send" action emails it to the customer.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { supabaseServer, orgId } from '@/lib/supabase';
import { formatCents, formatDate } from '@/lib/format';
import { Badge, statementStateTone } from '@/components/Badge';

export const dynamic = 'force-dynamic';

interface StatementDetail {
  id: string;
  state: string;
  currency: string;
  period_start_at: string;
  as_of_at: string;
  opening_balance_cents: number;
  charges_cents: number;
  payments_cents: number;
  closing_balance_cents: number;
  aging_current_cents: number;
  aging_30_cents: number;
  aging_60_cents: number;
  aging_90_plus_cents: number;
  generated_at: string;
  generated_by_agent: string | null;
  sent_at: string | null;
  notes: string | null;
  account: { id: string; name: string; billing_email: string | null } | null;
}

interface StatementLine {
  id: string;
  line_type: 'opening' | 'invoice' | 'payment' | 'closing';
  sort_order: number;
  occurred_at: string;
  description: string;
  reference_type: string | null;
  reference_id: string | null;
  amount_cents: number;
  running_balance_cents: number;
}

async function loadStatement(id: string): Promise<{
  statement: StatementDetail;
  lines: StatementLine[];
} | null> {
  const sb = supabaseServer();
  const org = orgId();

  const { data: statement, error: stErr } = await sb
    .from('statements')
    .select(
      'id, state, currency, period_start_at, as_of_at, opening_balance_cents, charges_cents, payments_cents, closing_balance_cents, aging_current_cents, aging_30_cents, aging_60_cents, aging_90_plus_cents, generated_at, generated_by_agent, sent_at, notes, account:accounts(id, name, billing_email)',
    )
    .eq('org_id', org)
    .eq('id', id)
    .maybeSingle();
  if (stErr) throw stErr;
  if (!statement) return null;

  const { data: lines, error: lnErr } = await sb
    .from('statement_lines')
    .select(
      'id, line_type, sort_order, occurred_at, description, reference_type, reference_id, amount_cents, running_balance_cents',
    )
    .eq('org_id', org)
    .eq('statement_id', id)
    .order('sort_order');
  if (lnErr) throw lnErr;

  return {
    statement: (statement as unknown) as StatementDetail,
    lines: ((lines as unknown) as StatementLine[]) ?? [],
  };
}

export default async function StatementDetailPage({
  params,
}: {
  params: { id: string };
}) {
  const result = await loadStatement(params.id);
  if (!result) notFound();
  const { statement: s, lines } = result;

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/statements"
          className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          ← All statements
        </Link>
        <div className="mt-2 flex items-baseline justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold">Statement of account</h1>
            <div className="mt-1 text-zinc-600 dark:text-zinc-400">
              {s.account?.name ?? '—'}
              {s.account?.billing_email ? (
                <> · <span className="font-mono text-sm">{s.account.billing_email}</span></>
              ) : null}
            </div>
          </div>
          <Badge tone={statementStateTone(s.state)}>{s.state}</Badge>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[2fr_1fr]">
        <div className="space-y-6">
          <PeriodHeader s={s} />
          <ActivityTable lines={lines} currency={s.currency} />
          <BalanceFooter s={s} />
        </div>
        <div className="space-y-4">
          <AgingPanel s={s} />
          <MetaPanel s={s} />
        </div>
      </div>
    </div>
  );
}

function PeriodHeader({ s }: { s: StatementDetail }) {
  return (
    <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
      <SummaryCell label="Period start" value={formatDate(s.period_start_at)} />
      <SummaryCell label="As of" value={formatDate(s.as_of_at)} />
      <SummaryCell label="Opening" value={formatCents(s.opening_balance_cents, s.currency)} />
      <SummaryCell
        label="Closing"
        value={formatCents(s.closing_balance_cents, s.currency)}
        emphasized
      />
    </div>
  );
}

function ActivityTable({ lines, currency }: { lines: StatementLine[]; currency: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 overflow-hidden">
      <table className="w-full text-sm">
        <thead className="bg-zinc-50 dark:bg-zinc-900 text-xs uppercase tracking-wide text-zinc-500">
          <tr>
            <th className="text-left px-4 py-2 font-medium">Date</th>
            <th className="text-left px-4 py-2 font-medium">Description</th>
            <th className="text-right px-4 py-2 font-medium">Amount</th>
            <th className="text-right px-4 py-2 font-medium">Balance</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
          {lines.map((line) => (
            <tr
              key={line.id}
              className={
                line.line_type === 'opening' || line.line_type === 'closing'
                  ? 'bg-zinc-50 dark:bg-zinc-900/40 font-medium'
                  : ''
              }
            >
              <td className="px-4 py-2 text-zinc-600 dark:text-zinc-400">
                {formatDate(line.occurred_at)}
              </td>
              <td className="px-4 py-2">
                {line.reference_type === 'invoice' && line.reference_id ? (
                  <Link
                    href={`/invoices/${line.reference_id}`}
                    className="hover:underline font-mono"
                  >
                    {line.description}
                  </Link>
                ) : (
                  line.description
                )}
              </td>
              <td
                className={`px-4 py-2 text-right font-mono ${
                  line.line_type === 'payment' ? 'text-green-700 dark:text-green-400' : ''
                }`}
              >
                {line.line_type === 'opening' || line.line_type === 'closing'
                  ? ''
                  : formatCents(line.amount_cents, currency)}
              </td>
              <td className="px-4 py-2 text-right font-mono">
                {formatCents(line.running_balance_cents, currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BalanceFooter({ s }: { s: StatementDetail }) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 text-sm">
      <div className="grid grid-cols-3 gap-4">
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">Charges</div>
          <div className="mt-1 font-mono">{formatCents(s.charges_cents, s.currency)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">Payments</div>
          <div className="mt-1 font-mono">{formatCents(s.payments_cents, s.currency)}</div>
        </div>
        <div>
          <div className="text-xs uppercase tracking-wide text-zinc-500">Closing balance</div>
          <div className="mt-1 font-mono text-lg font-semibold">
            {formatCents(s.closing_balance_cents, s.currency)}
          </div>
        </div>
      </div>
    </div>
  );
}

function AgingPanel({ s }: { s: StatementDetail }) {
  const bands: Array<{ label: string; amount: number; tone: string }> = [
    { label: 'Current', amount: s.aging_current_cents, tone: 'text-zinc-900 dark:text-zinc-100' },
    { label: '1-30 days', amount: s.aging_30_cents, tone: 'text-zinc-700 dark:text-zinc-300' },
    { label: '31-60 days', amount: s.aging_60_cents, tone: 'text-amber-700 dark:text-amber-300' },
    { label: '60+ days', amount: s.aging_90_plus_cents, tone: 'text-red-700 dark:text-red-400' },
  ];
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
      <div className="text-sm font-semibold uppercase tracking-wide text-zinc-500 mb-3">
        Aging
      </div>
      <ul className="space-y-1.5 text-sm">
        {bands.map((b) => (
          <li key={b.label} className="flex items-baseline justify-between gap-2">
            <span className="text-zinc-600 dark:text-zinc-400">{b.label}</span>
            <span className={`font-mono ${b.tone}`}>
              {formatCents(b.amount, s.currency)}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function MetaPanel({ s }: { s: StatementDetail }) {
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 text-sm space-y-1.5">
      <div className="text-xs uppercase tracking-wide text-zinc-500 mb-2">Generated</div>
      <div className="text-zinc-600 dark:text-zinc-400">
        {formatDate(s.generated_at)}
        {s.generated_by_agent ? ` by ${s.generated_by_agent}` : null}
      </div>
      {s.sent_at ? (
        <div className="text-zinc-600 dark:text-zinc-400">
          Sent {formatDate(s.sent_at)}
        </div>
      ) : null}
      {s.notes ? (
        <div className="pt-2 text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap">
          {s.notes}
        </div>
      ) : null}
    </div>
  );
}

function SummaryCell({
  label,
  value,
  emphasized = false,
}: {
  label: string;
  value: string;
  emphasized?: boolean;
}) {
  return (
    <div
      className={`rounded border px-3 py-2 ${
        emphasized
          ? 'border-zinc-900 dark:border-zinc-100'
          : 'border-zinc-200 dark:border-zinc-800'
      }`}
    >
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-0.5 font-mono ${emphasized ? 'text-lg font-semibold' : ''}`}>
        {value}
      </div>
    </div>
  );
}
