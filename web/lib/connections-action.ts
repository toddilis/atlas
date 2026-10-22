// Console Shopify connection action (0042): connect the shop or edit its cadence and
// enabled state. The operator is verified here (session, allowlist, same origin); the
// database enforces pause, the connections.save grant, the canonical domain, the
// one-connection-per-business rule, the fixed key, cadence bounds, stale edits and the
// audit trail. The browser gets back a fixed outcome code, never raw text.

import 'server-only';
import { OperatorAuthError, requireOperator } from './auth-server';
import { supabaseServer } from './supabase';
import { connectionOutcomeFor, type ConnectionOutcome } from './connections';

// Relative Location: request.url names Next's own hostname, not the browser's.
const back = (outcome: ConnectionOutcome) => new Response(null, { status: 303, headers: { Location: `/connections?outcome=${outcome}` } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function saveConnectionAction(request: Request) {
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
  const id = text('source_id');
  const expected = text('expected_updated_at');
  if (id !== '' && (!UUID.test(id) || expected === '' || Number.isNaN(Date.parse(expected)))) return back('not_found');
  const key = text('connection_key');
  if (id === '' && key === '') return back('bad_domain');
  const cadence = Number.parseInt(text('sync_every_minutes'), 10);
  if (!Number.isSafeInteger(cadence) || cadence < 1 || cadence > 1440) return back('cadence');

  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_save_shopify_connection', {
    p_org_id: operator.orgId,
    p_source_id: (id === '' ? null : id) as unknown as string,
    p_connection_key: (key === '' ? null : key) as unknown as string,
    p_enabled: form.get('enabled') === 'on',
    p_sync_every_minutes: cadence,
    p_expected_updated_at: (id === '' ? null : expected) as unknown as string,
    p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  if (!error) return back('connection_saved');
  const outcome = connectionOutcomeFor(error.message);
  if (outcome === 'failed') console.error('connections.save_failed', { error: error.message });
  return back(outcome);
}
