// Console job actions (retry, dismiss). The operator is verified here (session, allowlist,
// same origin); the database function enforces action pause, the operator's tool grant,
// that the job is unchanged since the page loaded and its current preconditions, and
// records who acted and why. The browser gets back a fixed outcome code, never raw text.

import 'server-only';
import { OperatorAuthError, requireOperator } from './auth-server';
import { supabaseServer } from './supabase';
import { actionOutcomeFor, type ActionOutcome } from './jobs';

// Relative Location: request.url names Next's own hostname, not the browser's.
const back = (outcome: ActionOutcome) => new Response(null, { status: 303, headers: { Location: `/jobs?outcome=${outcome}` } });

export async function jobAction(request: Request, rpc: 'retry_scheduled_job' | 'dismiss_scheduled_job', success: ActionOutcome) {
  let operator: Awaited<ReturnType<typeof requireOperator>>;
  try {
    operator = await requireOperator(request);
  } catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    if (error.status === 401) return new Response(null, { status: 303, headers: { Location: '/login' } });
    return Response.json({ error: error.message }, { status: error.status });
  }
  const form = await request.formData();
  const jobKey = form.get('job_key'), expected = form.get('expected_updated_at'), reason = form.get('reason');
  if (typeof jobKey !== 'string' || !jobKey || typeof expected !== 'string' || Number.isNaN(Date.parse(expected))) return back('failed');
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500) return back('reason');

  const sb = await supabaseServer();
  const { error } = await sb.rpc(rpc, {
    p_org_id: operator.orgId, p_job_key: jobKey, p_expected_updated_at: expected,
    p_actor_id: operator.actorId, p_actor_email: operator.email, p_reason: reason,
  });
  if (!error) return back(success);
  const outcome = actionOutcomeFor(error.message);
  if (outcome === 'failed') console.error('jobs.action_failed', { rpc, job_key: jobKey, error: error.message });
  return back(outcome);
}
