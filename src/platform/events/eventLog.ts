import { supabase, orgId } from '../../data/supabase.js';
import { log } from '../log.js';
import type { AppendedEvent, EventInput } from './types.js';
import { dispatchTracked, getProjectionState } from './projector.js';
import { EVENT_COLUMNS, toAppendedEvent } from './row.js';

/**
 * The append is the source of truth and never rolls back on projection failure — but since
 * PR-J the failure is *recorded*, not swallowed: every event carries a projection-state row
 * (0017 trigger), dispatch outcomes are written to it, and `projected` on the return value
 * tells the caller whether canonical state is current. Webhook handlers return non-2xx when
 * it is false so the provider redelivers; a redelivery of an unprojected event re-dispatches
 * (below); and the replay loop is the backstop for anything that slips past both.
 */
export type AppendResult = AppendedEvent & { projected: boolean };

/**
 * Append a single event to the spine, then dispatch projectors. Duplicate idempotency_key
 * returns the existing row — and, if that event never fully projected, re-dispatches its
 * projectors instead of skipping them (redelivery is the retry).
 */
export async function appendEvent(input: EventInput): Promise<AppendResult> {
  const sb = supabase();
  const row = {
    org_id: orgId(),
    type: input.type,
    source: input.source,
    agent_name: input.agentName ?? null,
    subject_type: input.subjectType ?? null,
    subject_id: input.subjectId ?? null,
    payload: input.payload,
    occurred_at: (input.occurredAt ?? new Date()).toISOString(),
    idempotency_key: input.idempotencyKey ?? null,
  };

  const { data, error } = await sb
    .from('event_log')
    .insert(row)
    .select(EVENT_COLUMNS)
    .single();

  if (error) {
    // Unique-violation on idempotency_key → the event already exists. Return the prior row,
    // but only treat the *projection* as done if it actually completed.
    if (error.code === '23505' && input.idempotencyKey) {
      const prior = await sb
        .from('event_log')
        .select(EVENT_COLUMNS)
        .eq('idempotency_key', input.idempotencyKey)
        .single();
      if (prior.error || !prior.data) throw error;
      const existing = toAppendedEvent(prior.data);

      const state = await getProjectionState(existing.id);
      if (state && state.state !== 'projected') {
        log.info('event_log.append.dedup_redispatch', {
          idempotency_key: input.idempotencyKey,
          prior_state: state.state,
          attempts: state.attempts,
        });
        const outcome = await dispatchTracked(existing, state.attempts);
        return { ...existing, projected: outcome.projected };
      }

      log.debug('event_log.append.dedup', { idempotency_key: input.idempotencyKey });
      return { ...existing, projected: true };
    }
    throw error;
  }

  const appended = toAppendedEvent(data);
  log.info('event_log.append', { seq: appended.seq, type: appended.type });

  const outcome = await dispatchTracked(appended, 0);
  return { ...appended, projected: outcome.projected };
}
