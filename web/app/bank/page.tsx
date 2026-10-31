// Bank (FLOW-01B, 0051/0052) — the business's bank accounts and the statement lines
// imported for them, every line kept once as evidence: the shared bank source the
// Controller matches customer receipts from and the Bookkeeper module will later code
// (PLAN D18). The database enforces the grants, pause, each account's fixed identity,
// stale edits, whole-file refusals, exactly-once storage and the payment rules; this page
// shows state, proposes receipt matches and collects the decisions.

import Link from 'next/link';
import { supabaseServer, orgId } from '@/lib/supabase';
import { formatCents, formatDateTime } from '@/lib/format';
import { bankNoticeText, BANK_OUTCOMES, readBankResult, statementDay } from '@/lib/bank-import';
import { classifyReceipt, type OpenInvoice } from '@/lib/bank-match';
import { Receipts, type MarkedRow, type ReceiptRow } from './receipts';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const day = statementDay;

interface AccountRow {
  id: string; display_name: string; bank_name: string; account_ref: string; currency: string;
  enabled: boolean; updated_at: string;
}
interface BatchRow {
  id: string; bank_account_id: string; file_name: string; line_count: number; new_count: number; existing_count: number;
  first_posted_on: string; last_posted_on: string; imported_by: string; created_at: string;
}
interface LineRow {
  id: string; bank_account_id: string; posted_on: string; amount_cents: number; currency: string;
  description: string; reference: string | null; counterparty: string | null;
  allocations: Array<{ amount_cents: number; invoice: { invoice_number: string } | null }> | null;
  reviews: Array<{ seq: number; decision: 'not_receipt' | 'reopened'; reason: string; decided_by: string }> | null;
}
const LINE_SELECT = 'id, bank_account_id, posted_on, amount_cents, currency, description, reference, counterparty, '
  + 'allocations:bank_receipt_allocations(amount_cents, invoice:invoices(invoice_number)), reviews:bank_line_reviews(seq, decision, reason, decided_by)';
const latestReview = (l: LineRow) => [...(l.reviews ?? [])].sort((a, b) => b.seq - a.seq)[0] ?? null;
const allocatedOf = (l: LineRow) => (l.allocations ?? []).reduce((n, a) => n + Number(a.amount_cents), 0);

/** What has become of a line: applied, marked, paid out, or still waiting. */
function lineStatus(l: LineRow): string {
  if (l.amount_cents < 0) return 'Paid out: for the books';
  if (l.amount_cents === 0) return '—';
  if (latestReview(l)?.decision === 'not_receipt') return 'Not a customer receipt';
  const allocated = allocatedOf(l);
  const numbers = (l.allocations ?? []).map(a => a.invoice?.invoice_number).filter(Boolean).join(', ');
  if (allocated >= l.amount_cents) return `Paid ${numbers}`;
  if (allocated > 0) return `Part-applied to ${numbers}`;
  return 'Not matched yet';
}

async function loadBank(selected: string | undefined) {
  const sb = await supabaseServer();
  const org = orgId();
  const [accounts, grants, controls, batches, credits, invoices] = await Promise.all([
    sb.from('bank_accounts').select('id, display_name, bank_name, account_ref, currency, enabled, updated_at')
      .eq('org_id', org).order('created_at', { ascending: true }),
    sb.from('tool_grants').select('tool_name, enabled').eq('org_id', org).eq('agent_name', 'operator')
      .in('tool_name', ['bank_accounts.save', 'bank.import', 'payments.record', 'bank.review']),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
    sb.from('bank_import_batches').select('id, bank_account_id, file_name, line_count, new_count, existing_count, first_posted_on, last_posted_on, imported_by, created_at')
      .eq('org_id', org).order('created_at', { ascending: false }).limit(10),
    sb.from('bank_transactions').select(LINE_SELECT).eq('org_id', org).gt('amount_cents', 0)
      .order('posted_on', { ascending: false }).order('source_row', { ascending: true }).limit(200),
    sb.from('invoices').select('id, invoice_number, currency, total_cents, payments(amount_cents)')
      .eq('org_id', org).in('state', ['issued', 'partial']).order('invoice_number', { ascending: true }).limit(500),
  ]);
  for (const r of [accounts, grants, controls, batches, credits, invoices]) if (r.error) throw r.error;
  const accountRows = (accounts.data ?? []) as AccountRow[];
  const account = selected && accountRows.some(a => a.id === selected) ? selected : null;

  let lineQuery = sb.from('bank_transactions')
    .select(LINE_SELECT)
    .eq('org_id', org).order('posted_on', { ascending: false }).order('created_at', { ascending: false })
    .order('source_row', { ascending: true }).limit(50);
  if (account) lineQuery = lineQuery.eq('bank_account_id', account);
  const [lines, ...stats] = await Promise.all([
    lineQuery,
    ...accountRows.map(a => sb.from('bank_transactions').select('posted_on', { count: 'exact' })
      .eq('org_id', org).eq('bank_account_id', a.id).order('posted_on', { ascending: false }).limit(1)),
  ]);
  if (lines.error) throw lines.error;
  for (const s of stats) if (s.error) throw s.error;

  // Shown so the operator knows before trying; the database enforces both on every write.
  const paused = Boolean(controls.data?.paused);
  const granted = (tool: string) => (grants.data ?? []).some(g => g.tool_name === tool && g.enabled);
  const off = [granted('bank_accounts.save') ? null : 'Account editing', granted('bank.import') ? null : 'Statement import'].filter(Boolean);

  // Receipt matching (0052): open invoices with what they still have outstanding, and every
  // credit line not yet fully applied, with the proposal for it.
  const nameOf = (id: string) => accountRows.find(a => a.id === id)?.display_name ?? '—';
  const open: OpenInvoice[] = ((invoices.data ?? []) as Array<{ id: string; invoice_number: string; currency: string; total_cents: number;
    payments: Array<{ amount_cents: number }> | null }>)
    .map(i => ({ id: i.id, invoice_number: i.invoice_number, currency: String(i.currency),
      outstanding_cents: Number(i.total_cents) - (i.payments ?? []).reduce((n, p) => n + Number(p.amount_cents), 0) }))
    .filter(i => i.outstanding_cents > 0);
  const receipts: ReceiptRow[] = [], marked: MarkedRow[] = [];
  for (const l of (credits.data ?? []) as unknown as LineRow[]) {
    const review = latestReview(l);
    if (review?.decision === 'not_receipt') {
      marked.push({ id: l.id, account: nameOf(l.bank_account_id), posted_on: l.posted_on, amount_cents: l.amount_cents,
        currency: l.currency, description: l.description, reason: review.reason, decided_by: review.decided_by });
      continue;
    }
    const allocated = allocatedOf(l);
    if (allocated >= l.amount_cents) continue;
    receipts.push({ id: l.id, account: nameOf(l.bank_account_id), posted_on: l.posted_on, amount_cents: l.amount_cents,
      remaining_cents: l.amount_cents - allocated, currency: l.currency, description: l.description, reference: l.reference,
      counterparty: l.counterparty,
      match: classifyReceipt({ amount_cents: l.amount_cents, currency: l.currency, reference: l.reference, description: l.description,
        allocated_cents: allocated, not_receipt: false }, open) });
  }
  const canAllocate = !paused && granted('payments.record'), canReview = !paused && granted('bank.review');
  return {
    receipts, marked, open, canAllocate, canReview,
    receiptsNote: paused ? null : [
      canAllocate ? null : 'Recording payments is switched off for this business (the operator payments.record grant is missing or revoked); a business turns it on deliberately.',
      canReview ? null : 'Marking lines as not a receipt is switched off for this business (the operator bank.review grant is missing or revoked).',
    ].filter(Boolean).join(' ') || null,
    accounts: accountRows.map((a, i) => ({ ...a, lines: stats[i].count ?? 0, latest: (stats[i].data?.[0]?.posted_on as string | undefined) ?? null })),
    batches: (batches.data ?? []) as BatchRow[],
    lines: (lines.data ?? []) as unknown as LineRow[],
    account,
    canSave: !paused && granted('bank_accounts.save'),
    canImport: !paused && granted('bank.import'),
    note: paused ? 'Business actions are paused, so accounts cannot be changed and statements cannot be imported until they are resumed.'
      : off.length > 0 ? `${off.join(' and ')} ${off.length === 1 ? 'is' : 'are'} switched off for this business (the operator grant is missing or revoked).` : null,
  };
}

async function noticeFor(params: Record<string, string | undefined>, accounts: AccountRow[]) {
  const result = readBankResult(params);
  if (!result) return null;
  let text = bankNoticeText(result);
  if ((result.outcome === 'imported' || result.outcome === 'already_imported') && params.batch && UUID.test(params.batch)) {
    const sb = await supabaseServer();
    const { data, error } = await sb.from('bank_import_batches')
      .select('bank_account_id, file_name, line_count, new_count, existing_count, imported_by, created_at')
      .eq('org_id', orgId()).eq('id', params.batch).maybeSingle();
    if (error) throw error;
    const name = accounts.find(a => a.id === data?.bank_account_id)?.display_name ?? 'the account';
    if (data) text = result.outcome === 'imported'
      ? `Imported ${data.file_name} into ${name}: ${data.line_count} rows, ${data.new_count} new, ${data.existing_count} already held.`
      : `This exact file (${data.file_name}) was already imported into ${name} on ${formatDateTime(data.created_at)} by ${data.imported_by}; nothing new was added.`;
  }
  if (result.outcome === 'allocated' && params.allocation && UUID.test(params.allocation)) {
    const sb = await supabaseServer();
    const { data, error } = await sb.from('bank_receipt_allocations')
      .select('amount_cents, invoice:invoices(invoice_number, state, currency), line:bank_transactions(posted_on)')
      .eq('org_id', orgId()).eq('id', params.allocation).maybeSingle();
    if (error) throw error;
    const invoice = data?.invoice as unknown as { invoice_number: string; state: string; currency: string } | null;
    const line = data?.line as unknown as { posted_on: string } | null;
    if (data && invoice && line) text = `Recorded ${formatCents(data.amount_cents, invoice.currency)} from the ${statementDay(line.posted_on)} bank line `
      + `against ${invoice.invoice_number}; the invoice is now ${invoice.state === 'paid' ? 'paid' : 'part-paid'}.`;
  }
  return { ok: BANK_OUTCOMES[result.outcome].ok, text };
}

const field = 'rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm';
const button = 'rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-3 py-1 text-sm font-medium';

export default async function BankPage({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const params = await searchParams;
  const { accounts, batches, lines, account, canSave, canImport, note, receipts, marked, open, canAllocate, canReview, receiptsNote } =
    await loadBank(params.account);
  const notice = await noticeFor(params, accounts);
  const nameOf = (id: string) => accounts.find(a => a.id === id)?.display_name ?? '—';
  const importable = accounts.filter(a => a.enabled);
  const preselected = importable.some(a => a.id === account) ? account! : importable[0]?.id;
  const totalLines = accounts.reduce((n, a) => n + a.lines, 0);

  return (
    <div className="space-y-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Bank</h1>
        <div className="text-sm text-zinc-500">
          {accounts.length} {accounts.length === 1 ? 'account' : 'accounts'} · {totalLines} {totalLines === 1 ? 'line' : 'lines'}
        </div>
      </div>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-3xl">
        Every statement line, kept once as evidence: importing the same file again, or an export
        that overlaps an earlier one, never stores a line twice. Money received is matched to the
        invoices it pays below; money paid out waits for the books.
      </p>

      {notice ? (
        <div data-testid="bank-notice" role="status" className={`rounded-lg border p-4 text-sm ${notice.ok
          ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
          : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'}`}>
          {notice.text}
        </div>
      ) : null}

      {note ? (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 text-sm text-zinc-600 dark:text-zinc-400">{note}</div>
      ) : null}

      <section className="space-y-3" aria-label="Accounts">
        <h2 className="text-lg font-semibold">Accounts</h2>
        {accounts.length === 0 ? (
          <div data-testid="bank-empty" className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-sm text-zinc-500">
            No bank accounts yet. Add each account the business receives or pays money through, one per currency
            balance (a multi-currency Wise account is one account per currency), then import its statements.
          </div>
        ) : (
          <div className="space-y-2">
            {accounts.map(a => (
              <div key={a.id} data-testid="bank-account" className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <div className="text-sm">
                    <span className="font-medium">{a.display_name}</span>
                    <span className="ml-2 text-zinc-500">{a.bank_name} · <span className="font-mono">{a.account_ref}</span> · {a.currency}</span>
                    {a.enabled ? null : <span className="ml-2 text-xs text-amber-700 dark:text-amber-300">Disabled: takes no imports.</span>}
                  </div>
                  <div className="text-xs text-zinc-500">
                    {a.lines === 0 ? 'No statement imported yet' : `${a.lines} ${a.lines === 1 ? 'line' : 'lines'}, latest dated ${day(a.latest)}`}
                  </div>
                </div>
                {canSave ? (
                  <form method="post" action="/bank/account" className="flex flex-wrap items-end gap-2">
                    <input type="hidden" name="account_id" value={a.id} />
                    <input type="hidden" name="expected_updated_at" value={a.updated_at} />
                    <label className="text-sm">Name<br />
                      <input name="display_name" aria-label={`Name for ${a.display_name}`} defaultValue={a.display_name}
                        required maxLength={100} className={`${field} w-56`} /></label>
                    <label className="text-sm flex items-center gap-1 pb-1">
                      <input type="checkbox" name="enabled" defaultChecked={a.enabled} /> Enabled
                    </label>
                    <button type="submit" className={button}>Save account</button>
                    <span className="pb-1 text-xs text-zinc-500">The bank, reference and currency are the account&rsquo;s identity and cannot change.</span>
                  </form>
                ) : null}
              </div>
            ))}
          </div>
        )}
        {canSave ? (
          <form method="post" action="/bank/account" className="flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
            <label className="text-sm">Account name<br />
              <input name="display_name" aria-label="Account name" placeholder="ASB Everyday" required maxLength={100} className={`${field} w-48`} /></label>
            <label className="text-sm">Bank<br />
              <input name="bank_name" aria-label="Bank" placeholder="ASB" required maxLength={60} className={`${field} w-28`} /></label>
            <label className="text-sm">Account reference<br />
              <input name="account_ref" aria-label="Account reference" placeholder="12-3456-0001234-00" required minLength={2} maxLength={40}
                className={`${field} w-48 font-mono`} /></label>
            <label className="text-sm">Currency<br />
              <input name="currency" aria-label="Currency" defaultValue="NZD" required minLength={3} maxLength={3} pattern="[A-Za-z]{3}"
                className={`${field} w-16 uppercase`} /></label>
            <input type="hidden" name="enabled" value="on" />
            <button type="submit" className={button}>Add account</button>
          </form>
        ) : null}
      </section>

      {importable.length > 0 && canImport ? (
        <section className="space-y-3" aria-label="Import a statement">
          <h2 className="text-lg font-semibold">Import a statement</h2>
          <form method="post" action="/bank/import" encType="multipart/form-data"
            className="flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
            <label className="text-sm">Import into account<br />
              <select name="bank_account_id" aria-label="Import into account" defaultValue={preselected} className={field}>
                {importable.map(a => <option key={a.id} value={a.id}>{a.display_name} ({a.currency})</option>)}
              </select></label>
            <label className="text-sm">Statement file<br />
              <input name="file" aria-label="Statement file" type="file" accept=".csv,text/csv" required className="text-sm" /></label>
            <button type="submit" className={button}>Import file</button>
          </form>
          <p className="text-xs text-zinc-500 max-w-3xl">
            A CSV file with a header row: <span className="font-mono">date</span> (YYYY-MM-DD), <span className="font-mono">amount</span> (signed,
            like -45.20) and <span className="font-mono">description</span>; optionally <span className="font-mono">reference</span>,{' '}
            <span className="font-mono">counterparty</span>, <span className="font-mono">transaction_id</span> and{' '}
            <span className="font-mono">currency</span>. Up to 5,000 rows and 2 MB per file. The whole file is checked first: one bad row
            refuses it and nothing is imported. Wise and ASB statement layouts follow once a real export confirms them.
          </p>
        </section>
      ) : null}

      {accounts.length > 0 ? (
        <Receipts receipts={receipts} marked={marked} open={open} canAllocate={canAllocate} canReview={canReview} note={receiptsNote} />
      ) : null}

      <section className="space-y-3" aria-label="Recent imports">
        <h2 className="text-lg font-semibold">Recent imports</h2>
        {batches.length === 0 ? (
          <div className="text-sm text-zinc-500">No statements imported yet.</div>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-left text-zinc-500">
              <tr><th className="py-1">When</th><th>Account</th><th>File</th><th>Dates</th><th className="text-right">Rows</th>
                <th className="text-right">New</th><th className="text-right">Already held</th><th className="pl-6">By</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {batches.map(b => (
                <tr key={b.id} data-testid="bank-import">
                  <td className="py-1">{formatDateTime(b.created_at)}</td>
                  <td>{nameOf(b.bank_account_id)}</td>
                  <td className="font-mono text-xs">{b.file_name}</td>
                  <td>{day(b.first_posted_on)} – {day(b.last_posted_on)}</td>
                  <td className="text-right">{b.line_count}</td>
                  <td className="text-right">{b.new_count}</td>
                  <td className="text-right">{b.existing_count}</td>
                  <td className="pl-6 text-zinc-500">{b.imported_by}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section className="space-y-3" aria-label="Statement lines">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 className="text-lg font-semibold">Statement lines</h2>
          {accounts.length > 1 ? (
            <div className="flex gap-3 text-sm">
              <Link href="/bank" className={account ? 'text-zinc-500 hover:underline' : 'font-medium'}>All accounts</Link>
              {accounts.map(a => (
                <Link key={a.id} href={`/bank?account=${a.id}`} className={account === a.id ? 'font-medium' : 'text-zinc-500 hover:underline'}>{a.display_name}</Link>
              ))}
            </div>
          ) : null}
        </div>
        {lines.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500">
            No statement lines yet. Lines appear here once a statement is imported.
          </div>
        ) : (
          <table data-testid="bank-lines" className="w-full text-sm">
            <thead className="text-left text-zinc-500">
              <tr><th className="py-1">Date</th><th>Description</th><th>Reference</th><th>Counterparty</th>
                {account ? null : <th>Account</th>}<th className="text-right">Amount</th><th className="pl-6">Status</th></tr>
            </thead>
            <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
              {lines.map(l => (
                <tr key={l.id} data-testid="bank-line">
                  <td className="py-1 whitespace-nowrap">{day(l.posted_on)}</td>
                  <td>{l.description}</td>
                  <td className="font-mono text-xs">{l.reference ?? ''}</td>
                  <td>{l.counterparty ?? ''}</td>
                  {account ? null : <td className="text-zinc-500">{nameOf(l.bank_account_id)}</td>}
                  <td className={`text-right font-mono ${l.amount_cents < 0 ? '' : 'text-green-700 dark:text-green-300'}`}>{formatCents(l.amount_cents, l.currency)}</td>
                  <td className="pl-6 text-xs text-zinc-500">{lineStatus(l)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {lines.length === 50 ? <div className="text-xs text-zinc-500">Showing the latest 50 lines.</div> : null}
      </section>
    </div>
  );
}
