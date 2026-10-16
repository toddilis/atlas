// Console action: retry a blocked or quarantined background job. The operator is verified
// here (session, allowlist, same origin); the database enforces action pause, the
// operator's jobs.retry grant, that the job is unchanged since the page loaded and that the
// dispatch still needs the work, and records who retried it and why.

import { OperatorAuthError, requireOperator } from '@/lib/auth-server';
import { supabaseServer } from '@/lib/supabase';
import { retryOutcomeFor, type RetryOutcome } from '@/lib/jobs';

// Relative Location: request.url names Next's own hostname, not the browser's.
const back = (outcome: RetryOutcome) => new Response(null, { status: 303, headers: { Location: `/jobs?retry=${outcome}` } });

export async function POST(request: Request) {
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
  const { error } = await sb.rpc('retry_scheduled_job', {
    p_org_id: operator.orgId, p_job_key: jobKey, p_expected_updated_at: expected,
    p_actor_id: operator.actorId, p_actor_email: operator.email, p_reason: reason,
  });
  if (!error) return back('retried');
  const outcome = retryOutcomeFor(error.message);
  if (outcome === 'failed') console.error('jobs.retry_failed', { job_key: jobKey, error: error.message });
  return back(outcome);
}
