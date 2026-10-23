// Console membership save (0049). The operator is verified here (session, allowlist,
// membership, same origin); the database enforces the grant, pause, identity, email
// validity, the lockout guards and stale edits. The browser gets back a fixed outcome
// code, never raw text.

import 'server-only';
import { OperatorAuthError, requireOperator } from './auth-server';
import { supabaseServer } from './supabase';
import { memberOutcomeFor, type MemberOutcome } from './members';

// Relative Location: request.url names Next's own hostname, not the browser's.
const back = (outcome: MemberOutcome) => new Response(null, { status: 303, headers: { Location: `/members?outcome=${outcome}` } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function saveMemberAction(request: Request) {
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
  const memberId = text('member_id'), email = text('email').toLowerCase(), enabled = text('enabled'), expected = text('expected_updated_at');
  if ((memberId !== '' && !UUID.test(memberId)) || (enabled !== 'true' && enabled !== 'false')) return back('invalid');
  if (email === '' || email.length > 320) return back('invalid');

  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_save_member', {
    p_org_id: operator.orgId, p_member_id: (memberId === '' ? null : memberId) as unknown as string,
    p_email: email, p_enabled: enabled === 'true',
    p_expected_updated_at: (expected === '' ? null : expected) as unknown as string,
    p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  if (!error) return back('member_saved');
  const outcome = memberOutcomeFor(error.message);
  if (outcome === 'failed') console.error('members.save_failed', { error: error.message });
  return back(outcome);
}
