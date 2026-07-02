import type { AppendedEvent } from './types.js';

/** Columns every event_log read must select to build an AppendedEvent. */
export const EVENT_COLUMNS =
  'id, seq, type, source, agent_name, subject_type, subject_id, payload, occurred_at, appended_at, idempotency_key';

/** Map a raw event_log row to the AppendedEvent shape. Shared by append, dedup, and replay. */
export function toAppendedEvent(row: Record<string, unknown>): AppendedEvent {
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
