// Console customer decision (0054): link a Shopify customer to a retailer, mark it not
// invoiced, or remove the decision. The operator is verified here (session, allowlist,
// membership, same origin); the database enforces pause, the customers.decide grant, an
// open same-business retailer, the reason to stop invoicing, stale edits, the release of
// the customer's held shipments and the audit trail. The browser gets back fixed outcome
// codes and counts, never raw text.

import 'server-only';
import { OperatorAuthError, requireOperator } from './auth-server';
import { supabaseServer } from './supabase';
import { customerOutcomeFor, type CustomerOutcome, type Decision } from './customers';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DECISIONS: readonly Decision[] = ['retailer', 'not_invoiced', 'undecided'];

// Relative Location: request.url names Next's own hostname, not the browser's.
function back(outcome: CustomerOutcome, extra: { q?: string; customer?: string; released?: number; notInvoiced?: number } = {}) {
  const params = new URLSearchParams({ outcome });
  if (extra.q) params.set('q', extra.q);
  if (extra.released) params.set('released', String(extra.released));
  if (extra.notInvoiced) params.set('kept', String(extra.notInvoiced));
  return new Response(null, { status: 303,
    headers: { Location: `/customers?${params.toString()}${extra.customer ? `#customer-${extra.customer}` : ''}` } });
}

export async function decideCustomerAction(request: Request) {
  let operator: Awaited<ReturnType<typeof requireOperator>>;
  try {
    operator = await requireOperator(request);
  } catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    if (error.status === 401) return new Response(null, { status: 303, headers: { Location: '/login' } });
    return Response.json({ error: error.message }, { status: error.status });
  }
  const form = await request.formData();
  const text = (name: string, max: number) => { const v = form.get(name); return typeof v === 'string' ? v.trim().slice(0, max) : ''; };
  const q = text('q', 100);
  const customer = text('customer_id', 36), decision = text('decision', 20) as Decision, expected = text('expected', 36);
  const account = text('account_id', 36);
  const rawNote = form.get('note');
  const note = typeof rawNote === 'string' ? rawNote.trim() : '';
  if (!UUID.test(customer)) return back('not_found', { q });
  if (!DECISIONS.includes(decision)) return back('failed', { q, customer });
  if (expected !== 'not_invoiced' && expected !== 'undecided' && !UUID.test(expected)) return back('stale', { q, customer });
  if (decision === 'retailer' && !UUID.test(account)) return back('retailer_required', { q, customer });
  if (decision === 'not_invoiced' && (note.length < 3 || note.length > 500)) return back('reason_required', { q, customer });

  const sb = await supabaseServer();
  const { data, error } = await sb.rpc('operator_decide_shopify_customer', {
    p_org_id: operator.orgId, p_customer_id: customer, p_decision: decision,
    p_account_id: (decision === 'retailer' ? account : null) as unknown as string,
    p_note: (decision === 'not_invoiced' ? note : null) as unknown as string,
    p_expected: expected, p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  if (error) {
    const outcome = customerOutcomeFor(error.message);
    if (outcome === 'failed') console.error('customers.decide_failed', { customer_id: customer, error: error.message });
    return back(outcome, { q, customer });
  }
  const result = (data as Array<{ odc_released: number; odc_not_invoiced: number; odc_unchanged: boolean }>)[0];
  if (result.odc_unchanged) return back('unchanged', { q, customer });
  return back(decision === 'retailer' ? 'linked' : decision, {
    q, customer, released: result.odc_released, notInvoiced: result.odc_not_invoiced,
  });
}
