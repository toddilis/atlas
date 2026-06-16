import { supabase, orgId } from '../../data/supabase.js';
import { log } from '../log.js';
import type { AppendedEvent, EventInput } from './types.js';
import { dispatch } from './projector.js';

/**
 * Append a single event to the spine, then dispatch projectors. The append is the source of
 * truth — projection failures are logged but never roll back the append (the projection can
 * be replayed). Duplicate idempotency_key returns the existing row instead of erroring.
 */
export async function appendEvent(input: EventInput): Promise<AppendedEvent> {
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
    .select('id, seq, type, source, agent_name, subject_type, subject_id, payload, occurred_at, appended_at, idempotency_key')
    .single();

  if (error) {
    // Unique-violation on idempotency_key → return the prior row, treat as a no-op append.
    if (error.code === '23505' && input.idempotencyKey) {
      const prior = await sb
        .from('event_log')
        .select('id, seq, type, source, agent_name, subject_type, subject_id, payload, occurred_at, appended_at, idempotency_key')
        .eq('idempotency_key', input.idempotencyKey)
        .single();
      if (prior.error || !prior.data) throw error;
      log.debug('event_log.append.dedup', { idempotency_key: input.idempotencyKey });
      return toAppended(prior.data);
    }
    throw error;
  }

  const appended = toAppended(data);
  log.info('event_log.append', { seq: appended.seq, type: appended.type });

  // Fire projections. Failures are caught + logged so the append itself is durable.
  try {
    await dispatch(appended);
  } catch (e) {
    log.error('event_log.projection_failed', {
      seq: appended.seq,
      type: appended.type,
      error: (e as Error).message,
    });
  }

  return appended;
}

function toAppended(row: Record<string, unknown>): AppendedEvent {
  return {
    id: row.id as string,
    seq: Number(row.seq),
    type: row.type as AppendedEvent['type'],
    source: row.source as string,
    agentName: (row.agent_name as string | null) ?? null,
    subjectType: (row.subject_type as string | null) ?? null,
    subjectId: (row.subject_id as string | null) ?? null,
    payload: (row.payload as Record<string, unknown>) ?? {},
    occurredAt: row.occurred_at as string,
    appendedAt: row.appended_at as string,
    idempotencyKey: (row.idempotency_key as string | null) ?? null,
  };
}
