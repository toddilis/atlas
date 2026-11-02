// Receivables (CLOSE-01e/f) — what each retailer owes and how late, aged in the business's
// calendar from stored due dates as of now, and the payment reminders drafted from it.
// The ageing is computed from the stored invoices and payments on each request with the
// same day count and buckets statements use; generated statements stay the formal
// record. Reminders are stored snapshots (0053); sending them stays the operator's act.

import Link from 'next/link';
import { supabaseServer, orgId } from '@/lib/supabase';
import { formatCents } from '@/lib/format';
import { businessTimezone } from '@/lib/business-timezone';
import { ageInvoices, ageingByRetailer, BUCKET_LABELS, BUCKETS, overdueInvoices, totalsByCurrency, type OpenInvoiceRow } from '@/lib/receivables';
import { DEFAULT_TIMEZONE } from '../../../src/platform/pricing/aging';
import { isReminderOutcome, REMINDER_OUTCOMES } from '@/lib/reminders';
import { Reminders, type ReminderRow } from './reminders';

export const dynamic = 'force-dynamic';

async function loadReceivables(asOf: Date) {
  const sb = await supabaseServer();
  const org = orgId();
  const [invoices, timezone, reminders, profile, business, grants, controls] = await Promise.all([
    sb.from('invoices').select('id, invoice_number, currency, total_cents, issued_at, due_at, account_id, account:accounts(name), payments(amount_cents)')
      .eq('org_id', org).in('state', ['issued', 'partial']).limit(2000),
    businessTimezone(org, asOf.toISOString()),
    sb.from('payment_reminders').select('id, account_id, currency, as_of_at, timezone, lines, overdue_cents, state, drafted_by, created_at, '
      + 'sent_at, sent_by, sent_channel, sent_note, voided_at, voided_by, voided_reason, account:accounts(name)')
      .eq('org_id', org).order('created_at', { ascending: false }).limit(50),
    sb.from('business_profiles').select('legal_name, payment_instructions').eq('org_id', org).maybeSingle(),
    sb.from('orgs').select('display_name').eq('id', org).single(),
    sb.from('tool_grants').select('tool_name, enabled').eq('org_id', org).eq('agent_name', 'operator')
      .in('tool_name', ['reminders.generate', 'reminders.record_send', 'reminders.void']),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
  ]);
  for (const r of [invoices, reminders, profile, business, grants, controls]) if (r.error) throw r.error;
  const rows: OpenInvoiceRow[] = ((invoices.data ?? []) as unknown as Array<{
    id: string; invoice_number: string; currency: string; total_cents: number; issued_at: string | null; due_at: string | null;
    account_id: string | null; account: { name: string } | null; payments: Array<{ amount_cents: number }> | null;
  }>).map(i => ({
    id: i.id, invoice_number: i.invoice_number, currency: String(i.currency), total_cents: Number(i.total_cents),
    paid_cents: (i.payments ?? []).reduce((n, p) => n + Number(p.amount_cents), 0),
    issued_at: i.issued_at, due_at: i.due_at, account_id: i.account_id, account_name: i.account?.name ?? null,
  }));
  // Shown so the operator knows before trying; the database enforces both on every write.
  const paused = Boolean(controls.data?.paused);
  const granted = (tool: string) => !paused && (grants.data ?? []).some(g => g.tool_name === tool && g.enabled);
  const off = [granted('reminders.generate') ? null : 'drafting', granted('reminders.record_send') ? null : 'recording sends',
    granted('reminders.void') ? null : 'voiding'].filter(Boolean);
  return {
    rows, timezone,
    reminders: (reminders.data ?? []) as unknown as ReminderRow[],
    businessName: profile.data?.legal_name?.trim() || business.data!.display_name,
    paymentInstructions: profile.data?.payment_instructions ?? null,
    canDraft: granted('reminders.generate'), canSend: granted('reminders.record_send'), canVoid: granted('reminders.void'),
    reminderNote: paused ? 'Business actions are paused, so reminders cannot be drafted, recorded or voided until they are resumed.'
      : off.length > 0 ? `Reminder ${off.join(', ')} is switched off for this business (the operator grant is missing or revoked).` : null,
  };
}

export default async function ReceivablesPage({ searchParams }: { searchParams: Promise<{ outcome?: string }> }) {
  const { outcome } = await searchParams;
  const notice = isReminderOutcome(outcome) ? REMINDER_OUTCOMES[outcome] : null;
  const asOf = new Date();
  const { rows, timezone, reminders, businessName, paymentInstructions, canDraft, canSend, canVoid, reminderNote } = await loadReceivables(asOf);
  const openDraft = (accountId: string | null, currency: string) =>
    reminders.find(r => r.state === 'draft' && r.account_id === accountId && r.currency === currency) ?? null;
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
      {notice ? (
        <div data-testid="receivables-notice" role="status" className={`rounded-lg border p-4 text-sm ${notice.ok
          ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
          : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'}`}>
          {notice.text}
        </div>
      ) : null}
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
                  <th className="text-right">Outstanding</th><th className="pl-6">Reminder</th></tr>
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
                    <td className="pl-6">
                      {r.total_cents === r.buckets.current || !r.account_id ? <span className="text-zinc-400">—</span>
                        : openDraft(r.account_id, r.currency) ? (
                          <a href={`#reminder-${openDraft(r.account_id, r.currency)!.id}`} className="underline-offset-2 hover:underline">Draft ready</a>
                        ) : canDraft ? (
                          <form method="post" action="/receivables/reminders/draft">
                            <input type="hidden" name="account_id" value={r.account_id} />
                            <input type="hidden" name="currency" value={r.currency} />
                            <button type="submit" className="rounded border border-zinc-300 dark:border-zinc-700 px-2 py-0.5 text-xs">Draft reminder</button>
                          </form>
                        ) : <span className="text-zinc-400">—</span>}
                    </td>
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

      <Reminders reminders={reminders} business={businessName} paymentInstructions={paymentInstructions}
        canSend={canSend} canVoid={canVoid} note={reminderNote} />
    </div>
  );
}
