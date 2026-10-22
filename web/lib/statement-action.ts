// Console statement generation (0044). The operator is verified here (session,
// allowlist, same origin); the timezone is resolved from the business's active pricing
// configuration — the same configuration that priced the invoices being aged (PORT-01) —
// and the database enforces the grant, pause, identity, bounds and the derivation. The
// browser gets back a fixed outcome code, never raw text.

import 'server-only';
import { OperatorAuthError, requireOperator } from './auth-server';
import { supabaseServer } from './supabase';
import { selectPricingVersion } from '../../src/platform/pricing/versioned';
import { statementOutcomeFor, type StatementOutcome } from './statements';

// Relative Location: request.url names Next's own hostname, not the browser's.
const back = (outcome: StatementOutcome) => new Response(null, { status: 303, headers: { Location: `/statements?outcome=${outcome}` } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

/** The business timezone comes from the active pricing configuration at the as-of
 * instant. A business with no active pricing cannot have drafted BILL invoices, so only
 * then does the database default apply (null). Any other resolution error is surfaced,
 * never papered over with a default calendar. */
async function businessTimezone(orgId: string, asOfIso: string): Promise<string | null> {
  const sb = await supabaseServer();
  const { data, error } = await sb.from('pricing_activations').select('version:pricing_versions!inner(config)').eq('org_id', orgId);
  if (error) throw error;
  const configs = (data ?? []).map(row => (row as unknown as { version: { config: unknown } }).version.config);
  if (configs.length === 0) return null;
  try {
    return selectPricingVersion(configs, orgId, asOfIso).timezone;
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('no effective configuration')) return null;
    throw cause;
  }
}

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
  const outcome = statementOutcomeFor(error.message);
  if (outcome === 'failed') console.error('statements.generate_failed', { error: error.message });
  return back(outcome);
}
