import { supabase, orgId } from '../../data/supabase.js';

export type ActivityKind = 'observation' | 'action' | 'decision' | 'note';

export interface ActivityInput {
  agentName: string;
  kind: ActivityKind;
  summary: string;
  subjectType?: string;
  subjectId?: string | null;
  eventId?: string | null;
  detail?: Record<string, unknown>;
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
    detail: input.detail ?? null,
  });
  if (error) throw error;
}
