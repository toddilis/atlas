// Invoice part panel (FLOW-01A, step 4b): what this part is and how it was priced, from its
// immutable snapshot; approving and issuing it exactly as shown; printing it and recording
// what happened. Plain forms posting to the protected routes (lib/invoice-action.ts).

import type { PricingSnapshot } from '../../src/platform/pricing/versioned';
import { formatDateTime } from '@/lib/format';
import { currentPrint, partLetter, type PrintOutcomeRow } from '@/lib/invoice-part';

export interface InvoicePartView {
  invoiceId: string; invoiceNumber: string; state: string; snapshot: PricingSnapshot; orderReference: string;
  dispatchKey: string; pricingVersion: string; documentSha: string; snapshotSha: string | null;
  canIssue: boolean; canRecordPrint: boolean; paused: boolean; prints: PrintOutcomeRow[];
}

const box = 'border rounded p-4 space-y-3 border-zinc-200 dark:border-zinc-800';
const field = 'border rounded px-2 py-1.5 w-full bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100 border-zinc-300 dark:border-zinc-700';
const button = 'border rounded px-3 py-1.5 text-sm disabled:opacity-40 border-zinc-300 dark:border-zinc-700';
const small = 'text-xs text-zinc-500';
const money = (minor: string, currency: string) => { const v = BigInt(minor); return `${currency} ${v / 100n}.${(v % 100n).toString().padStart(2, '0')}`; };

export function InvoicePart({ part }: { part: InvoicePartView }) {
  const s = part.snapshot;
  const letter = partLetter(part.invoiceNumber);
  const issued = ['issued', 'paid', 'partial', 'overdue'].includes(part.state);
  const latest = currentPrint(part.prints);
  return (
    <section aria-labelledby="part-heading" className="space-y-4">
      <h2 id="part-heading" className="text-lg font-medium">Invoice part{letter ? ` ${letter}` : ''} of order {part.orderReference}</h2>
      <p className="text-sm">
        Shipment {part.dispatchKey}, priced with pricing version {part.pricingVersion} on its {s.pricingDateBasis === 'order' ? 'order' : 'dispatch'} date.
        Freight: {money(s.freight.amount, s.currency)} <span className={small}>({s.freight.explanation}{s.freight.carrier ? `; carrier cost ${money(s.freight.carrier.cost, s.currency)} from ${s.freight.carrier.connectionId}` : ''})</span>.
        Tax {money(s.tax.amount, s.currency)}{s.tax.exempt ? ' (tax exempt)' : ''}. Due {s.terms.dueDate}.
      </p>
      <ul className={`${small} list-disc pl-5`}>{s.lines.map(l => <li key={l.lineId}>{l.description}: {l.dispatched} × {money(l.unitPrice, s.currency)} ({l.explanation})</li>)}</ul>

      {part.state === 'draft' && (
        <form method="post" action={`/invoices/${part.invoiceId}/approve`} className={box} aria-label="Approve and issue">
          <h3 className="font-medium">Approve and issue</h3>
          <p className="text-sm">
            You approve exactly this invoice: {money(s.total, s.currency)} to the retailer above, due {s.terms.dueDate}. If anything about it changed
            since this page loaded, nothing is issued. Issuing posts it to the ledger; it does not send or print it.
          </p>
          {!part.canIssue && <p role="status" className="text-sm text-amber-800">Invoice issuing is switched off for this business (operator grant <code>controller.issue_invoice</code>), so it cannot be approved here.</p>}
          {part.paused && <p role="status" className="text-sm text-amber-800">Business actions are paused, so nothing can be issued until they resume.</p>}
          <input type="hidden" name="snapshot_sha256" value={part.snapshotSha ?? ''} />
          <label className="block text-sm space-y-1"><span>Note (optional)</span><input name="note" aria-label="Approval note" maxLength={500} className={field} /></label>
          <button type="submit" className={button} disabled={!part.canIssue || part.paused || !part.snapshotSha}>Approve and issue {money(s.total, s.currency)}</button>
        </form>
      )}

      {issued && (
        <section className={box} aria-label="Print">
          <h3 className="font-medium">Print</h3>
          <p className="text-sm">
            <a href={`/invoices/${part.invoiceId}/print`} target="_blank" rel="noopener" className="underline">Open the printable invoice</a>.{' '}
            {latest
              ? <>Last recorded: <strong>{latest.outcome === 'printed' ? 'printed' : 'printing failed'}</strong> by {latest.actor_email}, {formatDateTime(latest.recorded_at)}{latest.note ? ` (${latest.note})` : ''}.</>
              : 'Not recorded as printed yet.'}
          </p>
          {!part.canRecordPrint && <p role="status" className="text-sm text-amber-800">Recording print outcomes is switched off for this business (operator grant <code>invoices.record_print</code>).</p>}
          <form method="post" action={`/invoices/${part.invoiceId}/print-outcome`} className="space-y-2">
            <input type="hidden" name="document_sha256" value={part.documentSha} />
            <label className="block text-sm space-y-1"><span>Note (required if printing failed)</span><input name="note" aria-label="Print note" maxLength={500} className={field} /></label>
            <div className="flex gap-3">
              <button type="submit" name="outcome" value="printed" className={button} disabled={!part.canRecordPrint || part.paused}>Record as printed</button>
              <button type="submit" name="outcome" value="failed" className={button} disabled={!part.canRecordPrint || part.paused}>Printing failed</button>
            </div>
          </form>
          {part.prints.length > 1 && (
            <ol className={`${small} space-y-1`} aria-label="Print history">
              {[...part.prints].sort((a, b) => b.recorded_at.localeCompare(a.recorded_at)).map((p, i) =>
                <li key={i}>{formatDateTime(p.recorded_at)}: {p.outcome === 'printed' ? 'printed' : 'printing failed'} by {p.actor_email}{p.note ? `: ${p.note}` : ''}</li>)}
            </ol>
          )}
          <p className={small}>Document {part.documentSha.slice(0, 12)}…, stored when the part was drafted. Printing does not confirm the retailer received it.</p>
        </section>
      )}
    </section>
  );
}
