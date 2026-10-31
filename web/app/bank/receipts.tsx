// Receipts to reconcile (FLOW-01B-b, 0052): credit lines in the bank source not yet applied
// to invoices, each with the proposal matching made and the evidence behind it. Confirming
// records the payment through the database's payment rules (grant, outstanding cap,
// exactly-once posting); the operator can instead choose the invoice, or mark the line as
// not a customer receipt with a reason. Marked lines can be reopened.

import { formatCents } from '@/lib/format';
import { centsToDecimal } from '@/lib/ledger-export';
import { statementDay } from '@/lib/bank-import';
import { matchSummary, type Match, type OpenInvoice } from '@/lib/bank-match';

export interface ReceiptRow {
  id: string; account: string; posted_on: string; amount_cents: number; remaining_cents: number; currency: string;
  description: string; reference: string | null; counterparty: string | null; match: Match;
}
export interface MarkedRow {
  id: string; account: string; posted_on: string; amount_cents: number; currency: string; description: string;
  reason: string; decided_by: string;
}

const field = 'rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm';
const button = 'rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-3 py-1 text-sm font-medium';
const quiet = 'rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-sm';

export function Receipts({ receipts, marked, open, canAllocate, canReview, note }: {
  receipts: ReceiptRow[]; marked: MarkedRow[]; open: OpenInvoice[]; canAllocate: boolean; canReview: boolean; note: string | null;
}) {
  return (
    <section className="space-y-3" aria-label="Receipts to reconcile">
      <h2 className="text-lg font-semibold">Receipts to reconcile</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-3xl">
        Money received that is not yet applied to an invoice. A proposal names its evidence: the invoice number in the
        bank reference, or only a matching amount, which needs your judgement. Nothing is recorded until you confirm it.
      </p>
      {note ? <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm text-zinc-600 dark:text-zinc-400">{note}</div> : null}
      {receipts.length === 0 ? (
        <div data-testid="bank-receipts-empty" className="text-sm text-zinc-500">No receipts waiting. Every credit line is applied or marked.</div>
      ) : receipts.map(r => {
        const money = (cents: number) => formatCents(cents, r.currency);
        const payable = open.filter(i => i.currency === r.currency && i.outstanding_cents > 0);
        const proposals = 'allocations' in r.match ? r.match.allocations : [];
        return (
          <div key={r.id} data-testid="bank-receipt" className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-2">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <div>
                <span className="font-medium">{r.description}</span>
                {r.reference ? <span className="ml-2 font-mono text-xs">{r.reference}</span> : null}
                {r.counterparty ? <span className="ml-2 text-zinc-500">{r.counterparty}</span> : null}
              </div>
              <div className="text-zinc-500">
                {statementDay(r.posted_on)} · {r.account} · <span className="font-mono text-green-700 dark:text-green-300">{money(r.amount_cents)}</span>
                {r.remaining_cents !== r.amount_cents ? <span> · {money(r.remaining_cents)} still to apply</span> : null}
              </div>
            </div>
            <div className={`text-sm ${r.match.kind === 'exact' || r.match.kind === 'split' ? 'text-zinc-800 dark:text-zinc-200' : 'text-amber-800 dark:text-amber-300'}`}>
              {matchSummary(r.match, money)}
            </div>
            {canAllocate && proposals.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {proposals.map(a => (
                  <form key={a.invoice.id} method="post" action="/bank/allocate">
                    <input type="hidden" name="line_id" value={r.id} />
                    <input type="hidden" name="invoice_id" value={a.invoice.id} />
                    <input type="hidden" name="amount" value={centsToDecimal(a.amount_cents)} />
                    <button type="submit" className={button}>
                      {r.match.kind === 'amount_only' ? 'Confirm' : 'Record'} {money(a.amount_cents)} against {a.invoice.invoice_number}
                    </button>
                  </form>
                ))}
              </div>
            ) : null}
            <div className="flex flex-wrap items-end gap-4">
              {canAllocate ? (payable.length > 0 ? (
                <form method="post" action="/bank/allocate" className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="line_id" value={r.id} />
                  <label className="text-xs text-zinc-500">Invoice<br />
                    <select name="invoice_id" aria-label="Invoice" className={field} defaultValue={proposals[0]?.invoice.id ?? payable[0].id}>
                      {payable.map(i => <option key={i.id} value={i.id}>{i.invoice_number} · {money(i.outstanding_cents)} outstanding</option>)}
                    </select></label>
                  <label className="text-xs text-zinc-500">Amount<br />
                    <input name="amount" aria-label="Amount" defaultValue={centsToDecimal(r.remaining_cents)} required maxLength={20}
                      className={`${field} w-28 font-mono`} /></label>
                  <button type="submit" className={quiet}>Record payment</button>
                </form>
              ) : <div className="text-xs text-zinc-500">No open invoice in {r.currency} to apply it to.</div>) : null}
              {canReview && r.remaining_cents === r.amount_cents ? (
                <form method="post" action="/bank/review" className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="line_id" value={r.id} />
                  <input type="hidden" name="decision" value="not_receipt" />
                  <label className="text-xs text-zinc-500">Reason<br />
                    <input name="reason" aria-label="Reason" placeholder="Owner transfer" required minLength={3} maxLength={500} className={`${field} w-56`} /></label>
                  <button type="submit" className={quiet}>Not a customer receipt</button>
                </form>
              ) : null}
            </div>
          </div>
        );
      })}
      {marked.length > 0 ? (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold text-zinc-600 dark:text-zinc-400">Marked as not a customer receipt</h3>
          {marked.map(m => (
            <div key={m.id} data-testid="bank-marked" className="flex flex-wrap items-end justify-between gap-2 rounded border border-zinc-200 dark:border-zinc-800 p-3 text-sm">
              <div>
                <span className="font-medium">{m.description}</span>
                <span className="ml-2 text-zinc-500">{statementDay(m.posted_on)} · {m.account} · {formatCents(m.amount_cents, m.currency)}</span>
                <div className="text-xs text-zinc-500">{m.reason} ({m.decided_by})</div>
              </div>
              {canReview ? (
                <form method="post" action="/bank/review" className="flex items-end gap-2">
                  <input type="hidden" name="line_id" value={m.id} />
                  <input type="hidden" name="decision" value="reopened" />
                  <input name="reason" aria-label="Reopen reason" placeholder="Why it is a receipt after all" required minLength={3} maxLength={500}
                    className={`${field} w-56`} />
                  <button type="submit" className={quiet}>Reopen</button>
                </form>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}
