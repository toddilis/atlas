// Console approval decision. The operator is verified here (session, allowlist, same
// origin); the database enforces action pause, the operator's approvals.decide grant,
// that the approval is still pending and unexpired, the proposing agent's own entitlement
// and policy snapshot, and records who decided and why. The browser gets back a fixed
// outcome code, never raw text.

import 'server-only';
import { OperatorAuthError, requireOperator } from './auth-server';
import { supabaseServer } from './supabase';
import { decideOutcomeFor, type ApprovalOutcome } from './approvals';

// Relative Location: request.url names Next's own hostname, not the browser's.
const back = (outcome: ApprovalOutcome) => new Response(null, { status: 303, headers: { Location: `/approvals?outcome=${outcome}` } });

export async function decideApprovalAction(request: Request) {
  let operator: Awaited<ReturnType<typeof requireOperator>>;
  try {
    operator = await requireOperator(request);
  } catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    if (error.status === 401) return new Response(null, { status: 303, headers: { Location: '/login' } });
    return Response.json({ error: error.message }, { status: error.status });
  }
  const form = await request.formData();
  const approvalId = form.get('approval_id'), disposition = form.get('disposition'), reason = form.get('reason');
  if (typeof approvalId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(approvalId)) return back('not_found');
  if (disposition !== 'approved' && disposition !== 'rejected') return back('failed');
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500) return back('reason');

  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_decide_approval', {
    p_org_id: operator.orgId, p_approval_id: approvalId,
    p_actor_id: operator.actorId, p_actor_email: operator.email,
    p_disposition: disposition, p_reason: reason,
  });
  if (!error) return back(disposition);
  const outcome = decideOutcomeFor(error.message);
  if (outcome === 'failed') console.error('approvals.decide_failed', { approval_id: approvalId, error: error.message });
  return back(outcome);
}
