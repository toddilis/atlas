// Console statement generation (0044). The operator is verified here (session,
// allowlist, same origin); the timezone is resolved from the business's active pricing
// configuration — the same configuration that priced the invoices being aged (PORT-01) —
// and the database enforces the grant, pause, identity, bounds and the derivation. The
// browser gets back a fixed outcome code, never raw text.

import 'server-only';
import { OperatorAuthError, requireOperator } from './auth-server';
import { supabaseServer } from './supabase';
import { businessTimezone } from './business-timezone';
import { statementOutcomeFor, type StatementOutcome } from './statements';

// Relative Location: request.url names Next's own hostname, not the browser's.
const back = (outcome: StatementOutcome) => new Response(null, { status: 303, headers: { Location: `/statements?outcome=${outcome}` } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function generateStatementAction(request: Request) {
  let operator: Awaited<ReturnType<typeof requireOperator>>;
  try {
    operator = await requireOperator(request);
  } catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    if (error.status === 401) return new Response(null, { status: 303, headers: { Location: '/login' } });
    return Response.json({ error: error.message }, { status: error.status });
  }
  const form = await request.formData();
  const text = (name: string) => { const v = form.get(name); return typeof v === 'string' ? v.trim() : ''; };
  const accountId = text('account_id'), periodStart = text('period_start'), asOfDate = text('as_of');
  if (!UUID.test(accountId) || !DATE.test(periodStart) || (asOfDate !== '' && !DATE.test(asOfDate))) return back('invalid');
  // A past day means its end; today or blank means now. The database refuses anything
  // genuinely in the future.
  const today = new Date().toISOString().slice(0, 10);
  if (asOfDate > today) return back('invalid');
  const asOfIso = asOfDate === '' || asOfDate === today ? new Date().toISOString() : `${asOfDate}T23:59:59Z`;

  const sb = await supabaseServer();
  let timezone: string | null;
  try {
    timezone = await businessTimezone(operator.orgId, asOfIso);
  } catch (error) {
    console.error('statements.timezone_failed', { error: error instanceof Error ? error.message : String(error) });
    return back('failed');
  }
  const { error } = await sb.rpc('operator_generate_statement', {
    p_org_id: operator.orgId, p_account_id: accountId,
    p_period_start_at: `${periodStart}T00:00:00Z`, p_as_of_at: asOfIso,
    p_timezone: timezone as unknown as string,
    p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  if (!error) return back('statement_generated');
  const outcome = statementOutcomeFor('generate', error.message);
  if (outcome === 'failed') console.error('statements.generate_failed', { error: error.message });
  return back(outcome);
}

// Lifecycle actions (0047). Outcomes land back on the statement's own page. The database
// enforces the grant, pause, identity, the transition rules and retry stability.
const backTo = (id: string, outcome: StatementOutcome) =>
  new Response(null, { status: 303, headers: { Location: `/statements/${id}?outcome=${outcome}` } });

async function lifecycleOperator(request: Request): Promise<Awaited<ReturnType<typeof requireOperator>> | Response> {
  try {
    return await requireOperator(request);
  } catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    if (error.status === 401) return new Response(null, { status: 303, headers: { Location: '/login' } });
    return Response.json({ error: error.message }, { status: error.status });
  }
}

export async function recordStatementSentAction(request: Request, statementId: string) {
  const operator = await lifecycleOperator(request);
  if (operator instanceof Response) return operator;
  if (!UUID.test(statementId)) return backTo(statementId, 'not_found');
  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_record_statement_sent', {
    p_org_id: operator.orgId, p_statement_id: statementId,
    p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  if (!error) return backTo(statementId, 'statement_sent');
  const outcome = statementOutcomeFor('send', error.message);
  if (outcome === 'failed') console.error('statements.record_send_failed', { error: error.message });
  return backTo(statementId, outcome);
}

export async function voidStatementAction(request: Request, statementId: string) {
  const operator = await lifecycleOperator(request);
  if (operator instanceof Response) return operator;
  if (!UUID.test(statementId)) return backTo(statementId, 'not_found');
  const form = await request.formData();
  const raw = form.get('reason');
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason.length < 3 || reason.length > 500) return backTo(statementId, 'void_invalid');
  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_void_statement', {
    p_org_id: operator.orgId, p_statement_id: statementId, p_reason: reason,
    p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  if (!error) return backTo(statementId, 'statement_voided');
  const outcome = statementOutcomeFor('void', error.message);
  if (outcome === 'failed') console.error('statements.void_failed', { error: error.message });
  return backTo(statementId, outcome);
}
