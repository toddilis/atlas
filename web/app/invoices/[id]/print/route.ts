// Printable invoice: the stored document of an issued invoice part, rendered from its
// immutable snapshot (0028) with the business and retailer named from their records.
// Opening it records nothing; the operator records the print outcome on the invoice page.

import { OperatorAuthError, requireOperator } from '@/lib/auth-server';
import { supabaseServer } from '@/lib/supabase';
import { renderInvoiceDocument, type InvoiceDocument } from '../../../../../src/agents/controller/invoice-document';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ISSUED = ['issued', 'paid', 'partial', 'overdue'];
const page = (status: number, body: string) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Invoice</title></head><body style="font:16px system-ui;margin:40px">${body}</body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let operator: Awaited<ReturnType<typeof requireOperator>>;
  try { operator = await requireOperator(request); }
  catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    return new Response(null, { status: 303, headers: { Location: '/login' } });
  }
  const { id } = await params;
  if (!UUID.test(id)) return page(404, '<p>Invoice not found.</p>');
  const sb = await supabaseServer();
  const [invoice, snapshot, org] = await Promise.all([
    sb.from('invoices').select('id, state, invoice_number, account:accounts(name)').eq('org_id', operator.orgId).eq('id', id).maybeSingle(),
    sb.from('invoice_calculation_snapshots').select('document').eq('org_id', operator.orgId).eq('invoice_id', id).maybeSingle(),
    sb.from('orgs').select('display_name').eq('id', operator.orgId).single(),
  ]);
  for (const r of [invoice, snapshot, org]) if (r.error) throw r.error;
  const back = `<p><a href="/invoices/${id}">Back to the invoice</a></p>`;
  if (!invoice.data || !snapshot.data) return page(404, `<p>This invoice has no stored document to print.</p>${back}`);
  if (!ISSUED.includes(invoice.data.state)) return page(409, `<p>Approve and issue this invoice before printing it.</p>${back}`);
  const account = invoice.data.account as unknown as { name: string } | null;
  const html = renderInvoiceDocument(snapshot.data.document as unknown as InvoiceDocument,
    { business: org.data!.display_name, retailer: account?.name ?? 'Unknown retailer' });
  // Screen-only toolbar; it does not print.
  const toolbar = `<style>@media print{.screen-only{display:none}}</style><div class="screen-only" style="margin-bottom:24px">`
    + `<button type="button" onclick="window.print()">Print</button> <a href="/invoices/${id}">Back to the invoice</a>`
    + ` <span style="font-size:12px;color:#5b6570">After printing, record the outcome on the invoice page.</span></div>`;
  return new Response(html.replace('<body>', `<body>${toolbar}`),
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
