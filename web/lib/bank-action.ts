// Console bank actions (FLOW-01B, 0051). The operator is verified here (session,
// allowlist, membership, same origin); the database enforces the grants, pause,
// identity, per-line validation, dedupe, the exactly-once payment path and the line
// state machine. The browser gets back a fixed outcome code, never raw text.

import 'server-only';
import { createHash } from 'node:crypto';
import { OperatorAuthError, requireOperator } from './auth-server';
import { supabaseServer } from './supabase';
import { bankOutcomeFor, parseBankCsv, type BankOutcome } from './bank';

const back = (outcome: BankOutcome) => new Response(null, { status: 303, headers: { Location: `/bank?outcome=${outcome}` } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function operatorOr(request: Request) {
  try { return { operator: await requireOperator(request) }; }
  catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    if (error.status === 401) return { refused: new Response(null, { status: 303, headers: { Location: '/login' } }) };
    return { refused: Response.json({ error: error.message }, { status: error.status }) };
  }
}

export async function importBankFileAction(request: Request) {
  const { operator, refused } = await operatorOr(request);
  if (!operator) return refused;
  const form = await request.formData();
  const accountName = String(form.get('account_name') ?? '').trim();
  const currency = String(form.get('currency') ?? '').trim().toUpperCase();
  const file = form.get('file');
  if (accountName === '' || accountName.length > 120 || !/^[A-Z]{3}$/.test(currency) || !(file instanceof File)) return back('invalid_file');
  if (file.size === 0 || file.size > 1_000_000) return back('invalid_file');
  const text = await file.text();
  const parsed = parseBankCsv(text);
  if ('error' in parsed) return back('invalid_file');
  const sha = createHash('sha256').update(text, 'utf8').digest('hex');

  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_import_bank_lines', {
    p_org_id: operator.orgId, p_account_name: accountName, p_currency: currency,
    p_file_name: file.name.slice(0, 200) || 'bank.csv', p_content_sha256: sha,
    p_lines: parsed.lines as unknown as string,
    p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  if (!error) return back('imported');
  const outcome = bankOutcomeFor('import', error.message);
  if (outcome === 'failed') console.error('bank.import_failed', { error: error.message });
  return back(outcome);
}

export async function matchBankLineAction(request: Request) {
  const { operator, refused } = await operatorOr(request);
  if (!operator) return refused;
  const form = await request.formData();
  const lineId = String(form.get('line_id') ?? '').trim();
  const invoiceId = String(form.get('invoice_id') ?? '').trim();
  if (!UUID.test(lineId) || !UUID.test(invoiceId)) return back('not_found');
  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_match_bank_line', {
    p_org_id: operator.orgId, p_line_id: lineId, p_invoice_id: invoiceId,
    p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  if (!error) return back('line_matched');
  const outcome = bankOutcomeFor('match', error.message);
  if (outcome === 'failed') console.error('bank.match_failed', { error: error.message });
  return back(outcome);
}

export async function setAsideBankLineAction(request: Request) {
  const { operator, refused } = await operatorOr(request);
  if (!operator) return refused;
  const form = await request.formData();
  const lineId = String(form.get('line_id') ?? '').trim();
  const reason = String(form.get('reason') ?? '').trim();
  if (!UUID.test(lineId)) return back('not_found');
  if (reason.length < 3 || reason.length > 500) return back('reason_required');
  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_set_aside_bank_line', {
    p_org_id: operator.orgId, p_line_id: lineId, p_reason: reason,
    p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  if (!error) return back('line_set_aside');
  const outcome = bankOutcomeFor('review', error.message);
  if (outcome === 'failed') console.error('bank.set_aside_failed', { error: error.message });
  return back(outcome);
}

export async function reopenBankLineAction(request: Request) {
  const { operator, refused } = await operatorOr(request);
  if (!operator) return refused;
  const form = await request.formData();
  const lineId = String(form.get('line_id') ?? '').trim();
  if (!UUID.test(lineId)) return back('not_found');
  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_reopen_bank_line', {
    p_org_id: operator.orgId, p_line_id: lineId,
    p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  if (!error) return back('line_reopened');
  const outcome = bankOutcomeFor('review', error.message);
  if (outcome === 'failed') console.error('bank.reopen_failed', { error: error.message });
  return back(outcome);
}
