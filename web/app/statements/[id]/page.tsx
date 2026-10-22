// Statement preview — the operator's view of one statement snapshot. Header with totals
// + aging, then line-by-line with running balance, and the lifecycle (0047): the
// printable customer document, recording that it was sent, and voiding a superseded
// snapshot with a reason. The database enforces the grants, pause and transitions.

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { supabaseServer, orgId } from '@/lib/supabase';
import { formatCents, formatDate } from '@/lib/format';
import { Badge, statementStateTone } from '@/components/Badge';
import { STATEMENT_OUTCOMES, isStatementOutcome } from '@/lib/statements';

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
  aging_90_cents: number;
  aging_90_plus_cents: number;
  credit_cents: number;
  generated_at: string;
  generated_by_agent: string | null;
  sent_at: string | null;
  sent_by: string | null;
  voided_at: string | null;
  voided_by: string | null;
  voided_reason: string | null;
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
  const sb = await supabaseServer();
  const org = orgId();

  const { data: statement, error: stErr } = await sb
    .from('statements')
    .select(
      'id, state, currency, period_start_at, as_of_at, opening_balance_cents, charges_cents, payments_cents, closing_balance_cents, aging_current_cents, aging_30_cents, aging_60_cents, aging_90_cents, aging_90_plus_cents, credit_cents, generated_at, generated_by_agent, sent_at, sent_by, voided_at, voided_by, voided_reason, notes, account:accounts(id, name, billing_email)',
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

/** Whether each lifecycle action is available: its grant on and actions not paused. The
 * database re-enforces both on every call; this only keeps the console honest. */
async function loadLifecycleState(): Promise<{ canSend: boolean; canVoid: boolean; paused: boolean }> {
  const sb = await supabaseServer();
  const org = orgId();
  const [grants, controls] = await Promise.all([
    sb.from('tool_grants').select('tool_name, enabled').eq('org_id', org).eq('agent_name', 'operator')
      .in('tool_name', ['statements.record_send', 'statements.void']),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
  ]);
  for (const r of [grants, controls]) if (r.error) throw r.error;
  const paused = Boolean(controls.data?.paused);
  const on = (tool: string) => (grants.data ?? []).some(g => g.tool_name === tool && g.enabled) && !paused;
  return { canSend: on('statements.record_send'), canVoid: on('statements.void'), paused };
}

export default async function StatementDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ outcome?: string }>;
}) {
  const { id } = await params;
  const { outcome } = await searchParams;
  const notice = isStatementOutcome(outcome) ? STATEMENT_OUTCOMES[outcome] : null;
  const [result, lifecycle] = await Promise.all([loadStatement(id), loadLifecycleState()]);
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

      {notice ? (
        <div data-testid="statement-notice" role="status" className={`rounded-lg border p-4 text-sm ${notice.ok
          ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
          : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'}`}>
          {notice.text}
        </div>
      ) : null}

      <LifecyclePanel s={s} lifecycle={lifecycle} />

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

const field = 'mt-1 block rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-sm';

/** The lifecycle actions. The customer document is always printable (a voided one prints
 * marked VOID); recording a send applies to a draft, and a void to a draft or a sent
 * statement. Each off-state says why instead of offering a dead control. */
function LifecyclePanel({
  s,
  lifecycle,
}: {
  s: StatementDetail;
  lifecycle: { canSend: boolean; canVoid: boolean; paused: boolean };
}) {
  const offReason = lifecycle.paused
    ? 'business actions are paused'
    : 'its operator grant is missing or revoked';
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <a
          href={`/statements/${s.id}/print`}
          className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1 font-medium hover:bg-zinc-50 dark:hover:bg-zinc-900"
        >
          Open printable statement
        </a>
        {s.state === 'draft' ? (
          lifecycle.canSend ? (
            <form method="post" action={`/statements/${s.id}/sent`} className="inline-flex items-center gap-2">
              <button type="submit" className="rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-3 py-1 text-sm font-medium">
                Record sent
              </button>
              <span className="text-xs text-zinc-500">You print or email it yourself; this records that you did.</span>
            </form>
          ) : (
            <span className="text-xs text-zinc-500">Recording a send is switched off ({offReason}).</span>
          )
        ) : null}
      </div>
      {s.state !== 'voided' ? (
        lifecycle.canVoid ? (
          <form method="post" action={`/statements/${s.id}/void`} className="flex flex-wrap items-end gap-2">
            <label className="text-sm">Void reason<br />
              <input name="reason" aria-label="Void reason" required minLength={3} maxLength={500} className={field}
                placeholder="Why this statement must no longer be relied on" size={44} /></label>
            <button type="submit" className="rounded border border-red-300 dark:border-red-800 text-red-700 dark:text-red-400 px-3 py-1 text-sm font-medium">
              Void statement
            </button>
            <span className="pb-1 text-xs text-zinc-500">The figures stay on record; generate a new statement to replace it.</span>
          </form>
        ) : (
          <div className="text-xs text-zinc-500">Voiding is switched off ({offReason}).</div>
        )
      ) : (
        <div data-testid="voided-detail" className="text-sm text-red-700 dark:text-red-400">
          Voided {formatDate(s.voided_at)}{s.voided_by ? ` by ${s.voided_by}` : ''}: {s.voided_reason}
        </div>
      )}
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
    { label: '61-90 days', amount: s.aging_90_cents, tone: 'text-orange-700 dark:text-orange-400' },
    { label: '90+ days', amount: s.aging_90_plus_cents, tone: 'text-red-700 dark:text-red-400' },
    ...(s.credit_cents > 0
      ? [{ label: 'Credit', amount: -s.credit_cents, tone: 'text-green-700 dark:text-green-400' }]
      : []),
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
          {s.sent_by ? ` by ${s.sent_by}` : null}
        </div>
      ) : null}
      {s.voided_at ? (
        <div className="text-red-700 dark:text-red-400">
          Voided {formatDate(s.voided_at)}
          {s.voided_by ? ` by ${s.voided_by}` : null}
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
