// Printable statement: the immutable snapshot (0015/0020) rendered as the customer-facing
// document, with the business profile (0045) around it exactly like the printed invoice.
// Opening it records nothing; the operator records the send on the statement page. A
// voided statement still renders — marked VOID — so history stays printable.

import { OperatorAuthError, requireOperator } from '@/lib/auth-server';
import { supabaseServer } from '@/lib/supabase';
import { formatDate } from '@/lib/format';
import {
  renderStatementDocument,
  type StatementDocumentData,
  type StatementDocumentLine,
} from '../../../../../src/agents/controller/statement-document';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const page = (status: number, body: string) => new Response(
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Statement</title></head><body style="font:16px system-ui;margin:40px">${body}</body></html>`,
  { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  let operator: Awaited<ReturnType<typeof requireOperator>>;
  try { operator = await requireOperator(request); }
  catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    return new Response(null, { status: 303, headers: { Location: '/login' } });
  }
  const { id } = await params;
  if (!UUID.test(id)) return page(404, '<p>Statement not found.</p>');
  const sb = await supabaseServer();
  const [statement, lines, org, profile] = await Promise.all([
    sb.from('statements').select('id, state, currency, period_start_at, as_of_at, opening_balance_cents, charges_cents, payments_cents, closing_balance_cents, aging_current_cents, aging_30_cents, aging_60_cents, aging_90_cents, aging_90_plus_cents, credit_cents, generated_at, voided_reason, account:accounts(name)').eq('org_id', operator.orgId).eq('id', id).maybeSingle(),
    sb.from('statement_lines').select('line_type, occurred_at, description, amount_cents, running_balance_cents').eq('org_id', operator.orgId).eq('statement_id', id).order('sort_order'),
    sb.from('orgs').select('display_name').eq('id', operator.orgId).single(),
    sb.from('business_profiles').select('legal_name, tax_label, tax_number, address, payment_instructions').eq('org_id', operator.orgId).maybeSingle(),
  ]);
  for (const r of [statement, lines, org, profile]) if (r.error) throw r.error;
  const back = `<p><a href="/statements/${id}">Back to the statement</a></p>`;
  if (!statement.data) return page(404, `<p>Statement not found.</p>${back}`);
  const s = statement.data;
  const account = s.account as unknown as { name: string } | null;
  const data: StatementDocumentData = {
    accountName: account?.name ?? 'Unknown retailer',
    state: s.state as StatementDocumentData['state'], currency: s.currency,
    periodStart: formatDate(s.period_start_at), asOf: formatDate(s.as_of_at),
    generatedOn: formatDate(s.generated_at),
    openingCents: s.opening_balance_cents, chargesCents: s.charges_cents,
    paymentsCents: s.payments_cents, closingCents: s.closing_balance_cents,
    agingCurrentCents: s.aging_current_cents, aging30Cents: s.aging_30_cents,
    aging60Cents: s.aging_60_cents, aging90Cents: s.aging_90_cents,
    aging90PlusCents: s.aging_90_plus_cents, creditCents: s.credit_cents,
    voidedReason: s.voided_reason,
    lines: ((lines.data ?? []) as Array<{ line_type: string; occurred_at: string; description: string; amount_cents: number; running_balance_cents: number }>).map((l): StatementDocumentLine => ({
      lineType: l.line_type as StatementDocumentLine['lineType'],
      occurredOn: formatDate(l.occurred_at), description: l.description,
      amountCents: l.amount_cents, runningBalanceCents: l.running_balance_cents,
    })),
  };
  const html = renderStatementDocument(data, {
    business: org.data!.display_name, retailer: account?.name ?? 'Unknown retailer',
    legalName: profile.data?.legal_name, taxLabel: profile.data?.tax_label,
    taxNumber: profile.data?.tax_number, address: profile.data?.address,
    paymentInstructions: profile.data?.payment_instructions,
  });
  // Screen-only toolbar; it does not print.
  const toolbar = `<style>@media print{.screen-only{display:none}}</style><div class="screen-only" style="margin-bottom:24px">`
    + `<button type="button" onclick="window.print()">Print</button> <a href="/statements/${id}">Back to the statement</a>`
    + ` <span style="font-size:12px;color:#5b6570">After sending it, record that on the statement page.</span></div>`;
  return new Response(html.replace('<body>', `<body>${toolbar}`),
    { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}
