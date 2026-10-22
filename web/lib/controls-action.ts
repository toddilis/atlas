// Console emergency stop (0041): pause or resume all business actions. The operator is
// verified here (session, allowlist, same origin); the database enforces the grant,
// identity and reason, writes the durable control row and the audit trail. The
// browser gets back a fixed outcome code, never raw text.

import 'server-only';
import { OperatorAuthError, requireOperator } from './auth-server';
import { supabaseServer } from './supabase';
import { controlsOutcomeFor, type ControlsOutcome } from './controls';

// Relative Location: request.url names Next's own hostname, not the browser's.
const back = (outcome: ControlsOutcome) => new Response(null, { status: 303, headers: { Location: `/?outcome=${outcome}` } });

export async function setPauseAction(request: Request) {
  let operator: Awaited<ReturnType<typeof requireOperator>>;
  try {
    operator = await requireOperator(request);
  } catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    if (error.status === 401) return new Response(null, { status: 303, headers: { Location: '/login' } });
    return Response.json({ error: error.message }, { status: error.status });
  }
  const form = await request.formData();
  const paused = form.get('paused'), reason = form.get('reason');
  if (paused !== 'true' && paused !== 'false') return back('failed');
  if (typeof reason !== 'string' || reason.trim().length < 3 || reason.length > 500) return back('reason');

  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_set_action_pause', {
    p_org_id: operator.orgId, p_paused: paused === 'true',
    p_actor_id: operator.actorId, p_actor_email: operator.email, p_reason: reason.trim(),
  });
  if (!error) return back(paused === 'true' ? 'paused_now' : 'resumed_now');
  const outcome = controlsOutcomeFor(error.message);
  if (outcome === 'failed') console.error('controls.pause_failed', { error: error.message });
  return back(outcome);
}
