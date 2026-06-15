// Scheduled digest builder — thin in Phase 0.
//
// The Phase 2 deliverable is: scheduled job rolls up agent_activity into a Claude-summarised
// digest delivered to Todd (email + console). In Phase 0 we expose the read function so the
// pieces are in place — the rollup of activity rows is deterministic; only the narration
// summary uses Claude (and that lives in Phase 2).

import { supabase, orgId } from '../../data/supabase.js';

export interface ActivityRow {
  id: string;
  agentName: string;
  kind: string;
  summary: string;
  subjectType: string | null;
  subjectId: string | null;
  occurredAt: string;
}

export async function activitySince(since: Date): Promise<ActivityRow[]> {
  const sb = supabase();
  const { data, error } = await sb
    .from('agent_activity')
    .select('id, agent_name, kind, summary, subject_type, subject_id, occurred_at')
    .eq('org_id', orgId())
    .gte('occurred_at', since.toISOString())
    .order('occurred_at', { ascending: true });
  if (error) throw error;
  return (data ?? []).map((r) => ({
    id: r.id as string,
    agentName: r.agent_name as string,
    kind: r.kind as string,
    summary: r.summary as string,
    subjectType: (r.subject_type as string | null) ?? null,
    subjectId: (r.subject_id as string | null) ?? null,
    occurredAt: r.occurred_at as string,
  }));
}
