import { supabase, orgId } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';

export type ActivityKind = 'observation' | 'action' | 'decision' | 'note';

export interface ActivityInput {
  agentName: string;
  kind: ActivityKind;
  summary: string;
  subjectType?: string;
  subjectId?: string | null;
  eventId?: string | null;
  detail?: Record<string, unknown>;
  /**
   * Optional idempotency key (0017 partial-unique on org_id + dedup_key). Pass one whenever
   * the write can be re-run — projector re-dispatch/replay retries — so the narrative stream
   * doesn't accumulate duplicates. A conflict is treated as already-recorded.
   */
  dedupKey?: string;
}

/**
 * Append to the narrative stream. The digest (Phase 2) rolls this up; the console activity
 * feed reads it directly. Distinct from event_log, which is the machine-readable spine.
 */
export async function recordActivity(input: ActivityInput): Promise<void> {
  const sb = supabase();
  const { error } = await sb.from('agent_activity').insert({
    org_id: orgId(),
    agent_name: input.agentName,
    kind: input.kind,
    summary: input.summary,
    subject_type: input.subjectType ?? null,
    subject_id: input.subjectId ?? null,
    event_id: input.eventId ?? null,
    detail: (input.detail ?? null) as unknown as Json,
    dedup_key: input.dedupKey ?? null,
  });
  if (error) {
    if (error.code === '23505' && input.dedupKey) return;   // already recorded — no-op
    throw error;
  }
}
