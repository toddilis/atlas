import type { PricingSnapshot } from '../../platform/pricing/versioned.js';

export interface InvoiceDocument {
  schemaVersion: 1; company_id: string; invoiceId: string; revision: 1;
  invoiceNumber: string; orderReference: string; calculation: PricingSnapshot;
}
const escape = (v: string) => v.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#39;');
const money = (value: string, currency: string) => {
  const n = BigInt(value); return `${escape(currency)} ${n / 100n}.${(n % 100n).toString().padStart(2,'0')}`;
};
/** Render stored content only. A caller must authorize the exact immutable reference.
 * No provider IO; generating HTML is not evidence of print, pack, email or receipt. */
export function renderInvoiceDocument(document: InvoiceDocument): string {
  const s = document.calculation;
  if (document.company_id !== s.businessId || s.scale !== 2 || document.revision !== 1) throw new Error('invoice document contract mismatch');
  const rows = s.lines.map(l => `<tr><td>${escape(l.description)}</td><td>${l.dispatched}</td><td>${money(l.unitPrice,s.currency)}</td><td>${money(l.lineAmount,s.currency)}</td></tr>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice ${escape(document.invoiceNumber)}</title><style>body{font:16px system-ui;margin:40px;color:#18212b}h1{font-size:28px}table{border-collapse:collapse;width:100%;margin:24px 0}td,th{padding:10px;text-align:right;border-bottom:1px solid #ccd2d8}td:first-child,th:first-child{text-align:left}.total{font-weight:bold}footer{margin-top:32px;font-size:12px}@media print{body{margin:12mm}}</style></head><body><h1>Invoice ${escape(document.invoiceNumber)}</h1><p>Order reference: ${escape(document.orderReference)}</p><p>Account: ${escape(s.input.accountId)}<br>Due date: ${escape(s.terms.dueDate)}</p><table><thead><tr><th>Description</th><th>Quantity</th><th>Unit price</th><th>Amount</th></tr></thead><tbody>${rows}<tr><td colspan="3">Products</td><td>${money(s.subtotal,s.currency)}</td></tr><tr><td colspan="3">Freight</td><td>${money(s.freight.amount,s.currency)}</td></tr><tr><td colspan="3">Tax (${s.tax.rateBps / 100}%)</td><td>${money(s.tax.amount,s.currency)}</td></tr><tr class="total"><td colspan="3">Total</td><td>${money(s.total,s.currency)}</td></tr></tbody></table><p>Terms: ${escape(s.terms.kind === 'explicit' ? s.terms.reason : `Day ${s.terms.day} of the month following ${s.terms.anchor}`)}</p><footer>Pricing version ${escape(s.configVersion)} · Document revision ${document.revision}<br>Document generation does not confirm printing or customer receipt.</footer></body></html>`;
}
