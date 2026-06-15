import { supabase, orgId } from '../../data/supabase.js';
import type { ApprovalState, RiskTier } from './types.js';

export interface ApprovalRequest {
  agentName: string;
  action: string;
  subjectType: string;
  subjectId?: string | null;
  payload: Record<string, unknown>;
  proposedSummary?: string;
  risk: RiskTier;
  expiresAt?: Date;
}

export interface ApprovalRecord {
  id: string;
  state: ApprovalState;
  decidedBy: string | null;
  decidedAt: string | null;
  reason: string | null;
}

/** Request an approval. Returns the row id. */
export async function requestApproval(req: ApprovalRequest): Promise<string> {
  const sb = supabase();
  const { data, error } = await sb
    .from('approvals')
    .insert({
      org_id: orgId(),
      agent_name: req.agentName,
      action: req.action,
      subject_type: req.subjectType,
      subject_id: req.subjectId ?? null,
      payload: req.payload,
      proposed_summary: req.proposedSummary ?? null,
      risk: req.risk,
      expires_at: req.expiresAt?.toISOString() ?? null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

export async function decideApproval(
  id: string,
  decision: 'approved' | 'rejected',
  decidedBy: string,
  reason?: string,
): Promise<void> {
  const sb = supabase();
  const { error } = await sb
    .from('approvals')
    .update({
      state: decision,
      decided_by: decidedBy,
      decided_at: new Date().toISOString(),
      reason: reason ?? null,
    })
    .eq('id', id)
    .eq('state', 'pending');                              // can only decide pending rows
  if (error) throw error;
}

export async function getApproval(id: string): Promise<ApprovalRecord | null> {
  const sb = supabase();
  const { data, error } = await sb
    .from('approvals')
    .select('id, state, decided_by, decided_at, reason')
    .eq('id', id)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id as string,
    state: data.state as ApprovalState,
    decidedBy: (data.decided_by as string | null) ?? null,
    decidedAt: (data.decided_at as string | null) ?? null,
    reason: (data.reason as string | null) ?? null,
  };
}
