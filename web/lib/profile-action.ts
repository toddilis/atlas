// Console business profile action (0045). The operator is verified here (session,
// allowlist, same origin); the database enforces the grant, pause, identity, bounds,
// stale edits and the audit trail. The browser gets back a fixed outcome code.

import 'server-only';
import { OperatorAuthError, requireOperator } from './auth-server';
import { supabaseServer } from './supabase';
import { profileOutcomeFor, type ProfileOutcome } from './profile';

// Relative Location: request.url names Next's own hostname, not the browser's.
const back = (outcome: ProfileOutcome) => new Response(null, { status: 303, headers: { Location: `/business?outcome=${outcome}` } });

export async function saveProfileAction(request: Request) {
  let operator: Awaited<ReturnType<typeof requireOperator>>;
  try {
    operator = await requireOperator(request);
  } catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    if (error.status === 401) return new Response(null, { status: 303, headers: { Location: '/login' } });
    return Response.json({ error: error.message }, { status: error.status });
  }
  const form = await request.formData();
  const text = (name: string, max: number) => {
    const value = form.get(name);
    return typeof value === 'string' && value.length <= max ? value.trim() : null;
  };
  const legalName = text('legal_name', 200), taxLabel = text('tax_label', 40), taxNumber = text('tax_number', 64);
  const address = text('address', 500), paymentInstructions = text('payment_instructions', 1000);
  const expected = text('expected_updated_at', 64);
  if ([legalName, taxLabel, taxNumber, address, paymentInstructions].includes(null)) return back('invalid');
  if (expected !== null && expected !== '' && Number.isNaN(Date.parse(expected))) return back('failed');

  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_save_business_profile', {
    p_org_id: operator.orgId,
    p_legal_name: legalName as unknown as string, p_tax_label: taxLabel as unknown as string,
    p_tax_number: taxNumber as unknown as string, p_address: address as unknown as string,
    p_payment_instructions: paymentInstructions as unknown as string,
    p_expected_updated_at: (expected || null) as unknown as string,
    p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  if (!error) return back('profile_saved');
  const outcome = profileOutcomeFor(error.message);
  if (outcome === 'failed') console.error('profile.save_failed', { error: error.message });
  return back(outcome);
}
