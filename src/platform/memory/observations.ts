import { supabase, orgId } from '../../data/supabase.js';

export type ObservationKind = 'fact' | 'preference' | 'pattern' | 'anomaly' | 'note';

export interface ObservationInput {
  agentName: string;
  kind: ObservationKind;
  content: string;
  subjectType?: string;
  subjectId?: string | null;
  sourceEventId?: string | null;
  confidence?: number;                          // 0..1, default 0.7
  metadata?: Record<string, unknown>;
  /**
   * Optional idempotency key (0017 partial-unique on org_id + dedup_key). Pass one whenever
   * the write can be re-run — projector re-dispatch/replay retries — so memory doesn't
   * accumulate duplicate observations. A conflict returns the existing row's id.
   */
  dedupKey?: string;
}

/**
 * Write a typed observation. The embedding column is left null in Phase 0; the deferred
 * consolidation worker populates it later. The CALLED CODE writes — no Claude in the path.
 */
export async function recordObservation(input: ObservationInput): Promise<string> {
  const sb = supabase();
  const { data, error } = await sb
    .from('observations')
    .insert({
      org_id: orgId(),
      agent_name: input.agentName,
      kind: input.kind,
      content: input.content,
      subject_type: input.subjectType ?? null,
      subject_id: input.subjectId ?? null,
      source_event_id: input.sourceEventId ?? null,
      confidence: input.confidence ?? 0.7,
      metadata: input.metadata ?? null,
      dedup_key: input.dedupKey ?? null,
    })
    .select('id')
    .single();
  if (error) {
    if (error.code === '23505' && input.dedupKey) {
      const existing = await sb
        .from('observations')
        .select('id')
        .eq('org_id', orgId())
        .eq('dedup_key', input.dedupKey)
        .single();
      if (existing.error || !existing.data) throw error;
      return existing.data.id as string;
    }
    throw error;
  }
  return data.id as string;
}

export interface ObservationQuery {
  agentName?: string;
  subjectType?: string;
  subjectId?: string;
  kind?: ObservationKind;
  limit?: number;
}

/** Plain query — no vector retrieval in Phase 0. */
export async function listObservations(q: ObservationQuery = {}): Promise<Array<Record<string, unknown>>> {
  const sb = supabase();
  let query = sb
    .from('observations')
    .select('id, agent_name, kind, subject_type, subject_id, content, confidence, occurred_at')
    .eq('org_id', orgId())
    .order('occurred_at', { ascending: false })
    .limit(q.limit ?? 50);
  if (q.agentName)   query = query.eq('agent_name', q.agentName);
  if (q.subjectType) query = query.eq('subject_type', q.subjectType);
  if (q.subjectId)   query = query.eq('subject_id', q.subjectId);
  if (q.kind)        query = query.eq('kind', q.kind);
  const { data, error } = await query;
  if (error) throw error;
  return data ?? [];
}
