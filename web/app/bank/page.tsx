// The bank page (FLOW-01B, 0051): import an export, and work every line to a resolved
// state. No line ever disappears silently — it is unmatched, matched to the payment it
// created, or set aside with a reason for the books (D18). Matching enforces the
// never-seeded payments.record grant through the exactly-once payment path.

import Link from 'next/link';
import { supabaseServer, orgId } from '@/lib/supabase';
import { formatCents, formatDate } from '@/lib/format';
import { Badge } from '@/components/Badge';
import { BANK_CSV_HEADER, BANK_OUTCOMES, isBankOutcome } from '@/lib/bank';

export const dynamic = 'force-dynamic';

interface LineRow {
  id: string; occurred_on: string; amount_cents: number; currency: string;
  description: string; reference: string | null; counterparty: string | null;
  state: 'unmatched' | 'matched' | 'set_aside'; matched_payment_id: string | null;
  set_aside_reason: string | null; resolved_by: string | null;
  account: { name: string } | null;
}
interface OpenInvoice { id: string; invoice_number: string; state: string; currency: string; total_cents: number; payments: Array<{ amount_cents: number }> | null }
interface ImportRow { id: string; file_name: string; line_count: number; inserted_count: number; created_at: string; imported_by: string; account: { name: string } | null }

async function loadBank() {
  const sb = await supabaseServer();
  const org = orgId();
  const [lines, invoices, imports, importGrant, paymentGrant, reviewGrant, controls, matchedInvoices] = await Promise.all([
    sb.from('bank_lines').select('id, occurred_on, amount_cents, currency, description, reference, counterparty, state, matched_payment_id, set_aside_reason, resolved_by, account:bank_accounts(name)')
      .eq('org_id', org).order('occurred_on', { ascending: false }).order('created_at', { ascending: false }).limit(200),
    sb.from('invoices').select('id, invoice_number, state, currency, total_cents, payments(amount_cents)')
      .eq('org_id', org).in('state', ['issued', 'partial']).order('invoice_number'),
    sb.from('bank_imports').select('id, file_name, line_count, inserted_count, created_at, imported_by, account:bank_accounts(name)')
      .eq('org_id', org).order('created_at', { ascending: false }).limit(10),
    sb.from('tool_grants').select('enabled').eq('org_id', org).eq('agent_name', 'operator').eq('tool_name', 'bank.import'),
    sb.from('tool_grants').select('enabled').eq('org_id', org).eq('agent_name', 'operator').eq('tool_name', 'payments.record'),
    sb.from('tool_grants').select('enabled').eq('org_id', org).eq('agent_name', 'operator').eq('tool_name', 'bank.review'),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
    sb.from('payments').select('id, invoice:invoices(invoice_number)').eq('org_id', org).not('reference', 'is', null).like('reference', 'bank:%'),
  ]);
  for (const r of [lines, invoices, imports, importGrant, paymentGrant, reviewGrant, controls, matchedInvoices]) if (r.error) throw r.error;
  const paused = Boolean(controls.data?.paused);
  const invoiceByPayment = new Map<string, string>();
  for (const p of (matchedInvoices.data ?? []) as unknown as Array<{ id: string; invoice: { invoice_number: string } | null }>) {
    invoiceByPayment.set(p.id, p.invoice?.invoice_number ?? '');
  }
  return {
    lines: ((lines.data ?? []) as unknown) as LineRow[],
    open: (((invoices.data ?? []) as unknown) as OpenInvoice[]).map(inv => ({
      ...inv,
      outstanding: inv.total_cents - (inv.payments ?? []).reduce((s, p) => s + Number(p.amount_cents), 0),
    })),
    imports: ((imports.data ?? []) as unknown) as ImportRow[],
    canImport: (importGrant.data ?? []).some(g => g.enabled) && !paused,
    canMatch: (paymentGrant.data ?? []).some(g => g.enabled) && !paused,
    canReview: (reviewGrant.data ?? []).some(g => g.enabled) && !paused,
    invoiceByPayment,
  };
}

const field = 'mt-1 block rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-950 px-2 py-1 text-sm';
const button = 'rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-3 py-1 text-sm font-medium';

export default async function BankPage({ searchParams }: { searchParams: Promise<{ outcome?: string }> }) {
  const { outcome } = await searchParams;
  const notice = isBankOutcome(outcome) ? BANK_OUTCOMES[outcome] : null;
  const { lines, open, imports, canImport, canMatch, canReview, invoiceByPayment } = await loadBank();
  const unmatched = lines.filter(l => l.state === 'unmatched');
  const matched = lines.filter(l => l.state === 'matched');
  const setAside = lines.filter(l => l.state === 'set_aside');

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Bank</h1>
        <div className="text-sm text-zinc-500">{unmatched.length} unmatched · {matched.length} matched · {setAside.length} set aside</div>
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-3xl">
        Every imported line is kept for the books and never disappears silently: it is unmatched,
        matched to the payment it created, or set aside with a reason. Interim CSV format:
        <span className="font-mono text-xs"> {BANK_CSV_HEADER}</span> (amounts signed, credits positive).
        The real Wise/ASB export becomes an adapter when its sample arrives.
      </p>

      {notice ? (
        <div data-testid="bank-notice" role="status" className={`rounded-lg border p-4 text-sm ${notice.ok
          ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
          : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'}`}>
          {notice.text}
        </div>
      ) : null}

      {canImport ? (
        <form method="post" action="/bank/import" encType="multipart/form-data"
          className="flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
          <label className="text-sm">Bank account<br />
            <input name="account_name" aria-label="Bank account name" required maxLength={120} defaultValue="Wise NZD" className={field} /></label>
          <label className="text-sm">Currency<br />
            <input name="currency" aria-label="Bank account currency" required pattern="[A-Za-z]{3}" defaultValue="NZD" size={4} className={field} /></label>
          <label className="text-sm">Export file<br />
            <input name="file" aria-label="Bank export file" type="file" accept=".csv,text/csv" required className={field} /></label>
          <button type="submit" className={button}>Import</button>
          <span className="pb-1 text-xs text-zinc-500">Re-importing or overlapping files never doubles a line.</span>
        </form>
      ) : (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 text-sm text-zinc-600 dark:text-zinc-400">
          Importing bank lines is switched off (the operator bank.import grant is off, or actions are paused); a business turns it on deliberately.
        </div>
      )}

      <section aria-label="Unmatched lines" className="space-y-3">
        <h2 className="text-lg font-semibold">Unmatched</h2>
        {unmatched.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center text-zinc-500">
            {lines.length === 0 ? 'No bank lines imported yet.' : 'Every imported line is matched or set aside.'}
          </div>
        ) : unmatched.map(l => (
          <div key={l.id} data-testid="bank-line" className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
            <LineSummary l={l} />
            <div className="flex flex-wrap items-end gap-2">
              {l.amount_cents > 0 ? (
                canMatch ? (
                  <form method="post" action="/bank/match" className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="line_id" value={l.id} />
                    <label className="text-sm">Invoice<br />
                      <select name="invoice_id" aria-label={`Match invoice for ${l.description}`} required defaultValue="" className={field}>
                        <option value="" disabled>Choose an invoice</option>
                        {open.filter(inv => inv.currency === l.currency).map(inv => (
                          <option key={inv.id} value={inv.id}>
                            {inv.invoice_number} — {formatCents(inv.outstanding, inv.currency)} outstanding
                            {inv.outstanding === l.amount_cents ? ' (exact match)' : ''}
                            {l.reference && l.reference.includes(inv.invoice_number) ? ' (referenced)' : ''}
                          </option>
                        ))}
                      </select></label>
                    <button type="submit" className={button}>Record payment</button>
                  </form>
                ) : (
                  <span className="text-xs text-zinc-500">Matching is switched off (the operator payments.record grant is off, or actions are paused); a business turns it on deliberately.</span>
                )
              ) : (
                <span className="text-xs text-zinc-500">A debit never matches an invoice; set it aside for the books.</span>
              )}
              {canReview ? (
                <form method="post" action="/bank/set-aside" className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="line_id" value={l.id} />
                  <label className="text-sm">Set aside<br />
                    <input name="reason" aria-label={`Set-aside reason for ${l.description}`} required minLength={3} maxLength={500}
                      placeholder="Why the Controller will not consume it" className={field} /></label>
                  <button type="submit" className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-sm font-medium">Set aside</button>
                </form>
              ) : null}
            </div>
          </div>
        ))}
      </section>

      <section aria-label="Set aside lines" className="space-y-3">
        <h2 className="text-lg font-semibold">Set aside</h2>
        {setAside.length === 0 ? (
          <div className="text-sm text-zinc-500">Nothing set aside.</div>
        ) : setAside.map(l => (
          <div key={l.id} data-testid="bank-line-aside" className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
            <LineSummary l={l} />
            <div className="flex items-center gap-3 text-sm">
              <span className="text-zinc-600 dark:text-zinc-400">Reason: {l.set_aside_reason} ({l.resolved_by})</span>
              {canReview ? (
                <form method="post" action="/bank/reopen" className="inline">
                  <input type="hidden" name="line_id" value={l.id} />
                  <button type="submit" className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-sm font-medium">Reopen</button>
                </form>
              ) : null}
            </div>
          </div>
        ))}
      </section>

      <section aria-label="Matched lines" className="space-y-3">
        <h2 className="text-lg font-semibold">Matched</h2>
        {matched.length === 0 ? (
          <div className="text-sm text-zinc-500">Nothing matched yet.</div>
        ) : matched.map(l => (
          <div key={l.id} data-testid="bank-line-matched" className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
            <LineSummary l={l} />
            <div className="text-sm text-zinc-600 dark:text-zinc-400 mt-1">
              Payment recorded{l.matched_payment_id && invoiceByPayment.get(l.matched_payment_id) ? <> on invoice <span className="font-mono">{invoiceByPayment.get(l.matched_payment_id)}</span></> : null} by {l.resolved_by}.
            </div>
          </div>
        ))}
      </section>

      <section aria-label="Imports" className="space-y-2">
        <h2 className="text-lg font-semibold">Imports</h2>
        {imports.length === 0 ? (
          <div className="text-sm text-zinc-500">No files imported yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500">
              <tr><th className="text-left py-1 font-medium">File</th><th className="text-left py-1 font-medium">Account</th>
                <th className="text-right py-1 font-medium">Lines</th><th className="text-right py-1 font-medium">New</th>
                <th className="text-left py-1 font-medium pl-4">Imported</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {imports.map(b => (
                <tr key={b.id} data-testid="bank-import">
                  <td className="py-1 font-mono">{b.file_name}</td>
                  <td className="py-1">{b.account?.name}</td>
                  <td className="py-1 text-right">{b.line_count}</td>
                  <td className="py-1 text-right">{b.inserted_count}</td>
                  <td className="py-1 pl-4 text-zinc-500">{formatDate(b.created_at)} by {b.imported_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <p className="text-xs text-zinc-500">
        Matched lines link to real payments on their <Link href="/invoices" className="underline">invoices</Link>;
        a matched line cannot be reopened, because its payment exists.
      </p>
    </div>
  );
}

function LineSummary({ l }: { l: LineRow }) {
  return (
    <div className="flex items-baseline justify-between gap-4 flex-wrap">
      <div className="text-sm">
        <span className="font-mono">{formatDate(l.occurred_on)}</span> · {l.description || '(no description)'}
        {l.reference ? <span className="text-zinc-500"> · ref {l.reference}</span> : null}
        {l.counterparty ? <span className="text-zinc-500"> · {l.counterparty}</span> : null}
        <span className="text-zinc-500"> · {l.account?.name}</span>
      </div>
      <div className="flex items-center gap-2">
        <span className={`font-mono ${l.amount_cents < 0 ? 'text-red-700 dark:text-red-400' : ''}`}>{formatCents(l.amount_cents, l.currency)}</span>
        <Badge tone={l.state === 'matched' ? 'green' : l.state === 'set_aside' ? 'amber' : 'zinc'}>{l.state === 'set_aside' ? 'set aside' : l.state}</Badge>
      </div>
    </div>
  );
}
