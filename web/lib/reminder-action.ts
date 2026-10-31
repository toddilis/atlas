// Console payment reminder actions (0053): draft one from the stored records, record that it
// was sent, or void a draft. The operator is verified here (session, allowlist, membership,
// same origin) and the business calendar is resolved as statements resolve it; the
// database enforces pause, the reminders grants, the overdue snapshot, one open draft per
// retailer and currency, the lifecycle and the audit trail. The browser gets back fixed
// outcome codes, never raw text.

import 'server-only';
import { OperatorAuthError, requireOperator } from './auth-server';
import { supabaseServer } from './supabase';
import { businessTimezone } from './business-timezone';
import { reminderOutcomeFor, type ReminderOutcome } from './reminders';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Relative Location: request.url names Next's own hostname, not the browser's.
const back = (outcome: ReminderOutcome, reminder?: string) => new Response(null, { status: 303,
  headers: { Location: `/receivables?outcome=${outcome}${reminder ? `#reminder-${reminder}` : ''}` } });

async function operatorOr(request: Request) {
  try { return { operator: await requireOperator(request) }; }
  catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    if (error.status === 401) return { refused: new Response(null, { status: 303, headers: { Location: '/login' } }) };
    return { refused: Response.json({ error: error.message }, { status: error.status }) };
  }
}
const field = (form: FormData, name: string, max: number) => { const v = form.get(name); return typeof v === 'string' && v.length <= max ? v.trim() : null; };

export async function draftReminderAction(request: Request) {
  const { operator, refused } = await operatorOr(request);
  if (!operator) return refused;
  const form = await request.formData();
  const accountId = field(form, 'account_id', 36), currency = field(form, 'currency', 3);
  if (!accountId || !UUID.test(accountId) || !currency || !/^[A-Za-z]{3}$/.test(currency)) return back('not_found');
  let timezone: string | null;
  try { timezone = await businessTimezone(operator.orgId, new Date().toISOString()); }
  catch (error) {
    console.error('reminders.timezone_failed', { error: error instanceof Error ? error.message : String(error) });
    return back('failed');
  }
  const sb = await supabaseServer();
  const { data, error } = await sb.rpc('operator_draft_payment_reminder', {
    p_org_id: operator.orgId, p_account_id: accountId, p_currency: currency,
    p_timezone: timezone as unknown as string, p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  if (error) {
    const outcome = reminderOutcomeFor(error.message);
    if (outcome === 'failed') console.error('reminders.draft_failed', { error: error.message });
    return back(outcome);
  }
  const stored = (data as Array<{ odr_reminder_id: string; odr_was_existing: boolean }>)[0];
  return back(stored.odr_was_existing ? 'reminder_open' : 'reminder_drafted', stored.odr_reminder_id);
}

export async function recordReminderSentAction(request: Request) {
  const { operator, refused } = await operatorOr(request);
  if (!operator) return refused;
  const form = await request.formData();
  const id = field(form, 'reminder_id', 36), channel = field(form, 'channel', 10), note = field(form, 'note', 500);
  if (!id || !UUID.test(id)) return back('not_found');
  if (!channel || note === null) return back('channel_required', id);
  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_record_reminder_sent', {
    p_org_id: operator.orgId, p_reminder_id: id, p_channel: channel, p_note: note,
    p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  if (!error) return back('reminder_sent', id);
  const outcome = reminderOutcomeFor(error.message);
  if (outcome === 'failed') console.error('reminders.record_send_failed', { reminder_id: id, error: error.message });
  return back(outcome, id);
}

export async function voidReminderAction(request: Request) {
  const { operator, refused } = await operatorOr(request);
  if (!operator) return refused;
  const form = await request.formData();
  const id = field(form, 'reminder_id', 36), reason = field(form, 'reason', 500);
  if (!id || !UUID.test(id)) return back('not_found');
  if (!reason || reason.length < 3) return back('reason_required', id);
  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_void_payment_reminder', {
    p_org_id: operator.orgId, p_reminder_id: id, p_reason: reason, p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  if (!error) return back('reminder_voided', id);
  const outcome = reminderOutcomeFor(error.message);
  if (outcome === 'failed') console.error('reminders.void_failed', { reminder_id: id, error: error.message });
  return back(outcome, id);
}
