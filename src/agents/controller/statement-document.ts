import type { InvoiceParties } from './invoice-document.js';

/** The customer-facing rendering of one immutable statement snapshot (0015/0020). The
 * caller passes the stored row and lines verbatim (cents as the database returned them,
 * dates already formatted for the customer) plus the business profile presentation
 * (0045), exactly as the invoice document does. Payments carry negative amounts in
 * statement_lines; the renderer preserves the sign. */
export interface StatementDocumentLine {
  lineType: 'opening' | 'invoice' | 'payment' | 'closing';
  occurredOn: string; description: string;
  amountCents: number | string; runningBalanceCents: number | string;
}
export interface StatementDocumentData {
  accountName: string; state: 'draft' | 'sent' | 'voided'; currency: string;
  periodStart: string; asOf: string; generatedOn: string;
  openingCents: number | string; chargesCents: number | string;
  paymentsCents: number | string; closingCents: number | string;
  agingCurrentCents: number | string; aging30Cents: number | string;
  aging60Cents: number | string; aging90Cents: number | string;
  aging90PlusCents: number | string; creditCents: number | string;
  voidedReason?: string | null;
  lines: StatementDocumentLine[];
}
const escape = (v: string) => v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const money = (value: number | string, currency: string) => {
  const n = BigInt(value); const abs = n < 0n ? -n : n;
  return `${escape(currency)} ${n < 0n ? '-' : ''}${abs / 100n}.${(abs % 100n).toString().padStart(2,'0')}`;
};
const profileLines = (v: string) => v.split('\n').map(line => escape(line)).join('<br>');
/** Render stored content only. No provider IO; generating HTML is not evidence that the
 * statement was printed, emailed or received — the operator records that separately. */
export function renderStatementDocument(data: StatementDocumentData, parties?: InvoiceParties): string {
  const c = data.currency;
  const rows = data.lines.map(l => `<tr${l.lineType === 'opening' || l.lineType === 'closing' ? ' class="bold"' : ''}><td>${escape(l.occurredOn)}</td><td>${escape(l.description)}</td><td>${l.lineType === 'opening' || l.lineType === 'closing' ? '' : money(l.amountCents, c)}</td><td>${money(l.runningBalanceCents, c)}</td></tr>`).join('');
  const aging = ([['Current', data.agingCurrentCents], ['1–30 days', data.aging30Cents], ['31–60 days', data.aging60Cents], ['61–90 days', data.aging90Cents], ['90+ days', data.aging90PlusCents]] as const)
    .map(([label, cents]) => `<tr><td>${label}</td><td>${money(cents, c)}</td></tr>`).join('')
    + (BigInt(data.creditCents) > 0n ? `<tr><td>Credit</td><td>${money((-BigInt(data.creditCents)).toString(), c)}</td></tr>` : '');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Statement${data.state === 'voided' ? ' (VOID)' : ''} — ${escape(data.accountName)}</title><style>body{font:16px system-ui;margin:40px;color:#18212b}h1{font-size:28px}table{border-collapse:collapse;width:100%;margin:24px 0}td,th{padding:10px;text-align:right;border-bottom:1px solid #ccd2d8}td:first-child,th:first-child,td:nth-child(2),th:nth-child(2){text-align:left}.bold{font-weight:bold}.void{color:#b3261e;border:2px solid #b3261e;display:inline-block;padding:4px 12px;font-weight:bold}.aging{width:auto;min-width:320px}footer{margin-top:32px;font-size:12px}@media print{body{margin:12mm}}</style></head><body><h1>Statement of account</h1>${data.state === 'voided' ? `<p class="void">VOID${data.voidedReason ? ` — ${escape(data.voidedReason)}` : ''}</p>` : ''}<p>${parties ? `From: ${escape(parties.legalName || parties.business)}${parties.address ? `<br>${profileLines(parties.address)}` : ''}${parties.taxNumber ? `<br>${escape(parties.taxLabel || 'Tax number')}: ${escape(parties.taxNumber)}` : ''}<br>To: ${escape(parties.retailer)}` : `To: ${escape(data.accountName)}`}<br>Period: ${escape(data.periodStart)} to ${escape(data.asOf)}</p><table><thead><tr><th>Date</th><th>Description</th><th>Amount</th><th>Balance</th></tr></thead><tbody>${rows}</tbody></table><p>Opening ${money(data.openingCents, c)} + charges ${money(data.chargesCents, c)} − payments ${money(data.paymentsCents, c)} = <strong>closing ${money(data.closingCents, c)}</strong></p><h2>Aging</h2><table class="aging"><tbody>${aging}</tbody></table>${parties?.paymentInstructions ? `<p>Payment: ${profileLines(parties.paymentInstructions)}</p>` : ''}<footer>Generated ${escape(data.generatedOn)} · Document generation does not confirm delivery to the customer.</footer></body></html>`;
}
