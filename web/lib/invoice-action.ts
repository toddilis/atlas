// Console invoice part actions: approve-and-issue, and record a print outcome. The operator
// is verified here (session, allowlist, same origin); the database function enforces action
// pause, the business's operator grant, the exact snapshot or document the page showed, and
// the invoice's state, and records who acted (0034). The browser gets back a fixed outcome
// code, never raw database text.

import 'server-only';
import { OperatorAuthError, requireOperator } from './auth-server';
import { supabaseServer } from './supabase';
import { invoiceOutcomeFor, type InvoiceOutcome } from './invoice-part';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST = /^[0-9a-f]{64}$/;
// Relative Location: request.url names Next's own hostname, not the browser's.
const back = (id: string, outcome: InvoiceOutcome) =>
  new Response(null, { status: 303, headers: { Location: `/invoices/${id}?outcome=${outcome}` } });

async function operatorOr(request: Request) {
  try { return { operator: await requireOperator(request) }; }
  catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    if (error.status === 401) return { refused: new Response(null, { status: 303, headers: { Location: '/login' } }) };
    return { refused: Response.json({ error: error.message }, { status: error.status }) };
  }
}
const text = (value: FormDataEntryValue | null, max: number) => typeof value === 'string' && value.length <= max ? value : null;

export async function approveInvoice(request: Request, invoiceId: string) {
  const { operator, refused } = await operatorOr(request);
  if (!operator) return refused;
  if (!UUID.test(invoiceId)) return new Response(null, { status: 404 });
  const form = await request.formData();
  const digest = text(form.get('snapshot_sha256'), 64), note = text(form.get('note'), 500);
  if (!digest || !DIGEST.test(digest) || note === null) return back(invoiceId, 'failed');
  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_approve_invoice_part', {
    p_org_id: operator.orgId, p_invoice_id: invoiceId, p_expected_snapshot_sha: digest,
    p_actor_id: operator.actorId, p_actor_email: operator.email, p_note: note.trim() || null,
  });
  if (!error) return back(invoiceId, 'issued');
  const outcome = invoiceOutcomeFor('approve', error.message);
  if (outcome === 'failed') console.error('invoices.approve_failed', { invoice_id: invoiceId, error: error.message });
  return back(invoiceId, outcome);
}

export async function recordPrint(request: Request, invoiceId: string) {
  const { operator, refused } = await operatorOr(request);
  if (!operator) return refused;
  if (!UUID.test(invoiceId)) return new Response(null, { status: 404 });
  const form = await request.formData();
  const digest = text(form.get('document_sha256'), 64), outcome = form.get('outcome'), note = text(form.get('note'), 500);
  if (!digest || !DIGEST.test(digest) || (outcome !== 'printed' && outcome !== 'failed') || note === null) return back(invoiceId, 'failed');
  if (outcome === 'failed' && note.trim().length < 3) return back(invoiceId, 'note');
  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_record_invoice_print', {
    p_org_id: operator.orgId, p_invoice_id: invoiceId, p_outcome: outcome, p_expected_document_sha: digest,
    p_actor_id: operator.actorId, p_actor_email: operator.email, p_note: note.trim() || null,
  });
  if (!error) return back(invoiceId, outcome === 'printed' ? 'printed' : 'print_failed');
  const code = invoiceOutcomeFor('print', error.message);
  if (code === 'failed') console.error('invoices.print_failed', { invoice_id: invoiceId, error: error.message });
  return back(invoiceId, code);
}
