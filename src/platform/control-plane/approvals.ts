import { supabase, orgId } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';
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
  expiresAt: string | null;
  executedAt: string | null;
}

/** Legacy informational proposal only; execution requires a newly prepared bound action. */
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
      payload: req.payload as unknown as NonNullable<Json>,
      proposed_summary: req.proposedSummary ?? null,
      risk: req.risk,
      expires_at: req.expiresAt?.toISOString() ?? null,
    })
    .select('id')
    .single();
  if (error) throw error;
  return data.id as string;
}

/**
 * Decide a pending bound approval under a database lock, checking expiry and authority.
 */
export async function decideApproval(
  id: string,
  decision: 'approved' | 'rejected',
  decidedBy: string,
  reason?: string,
): Promise<void> {
  const { error } = await supabase().rpc('decide_bound_approval', {
    p_org_id: orgId(), p_approval_id: id, p_disposition: decision,
    p_actor: decidedBy, p_reason: reason,
  });
  if (error) throw error;
}

/**
 * @deprecated Unbound consumption cannot authorize business execution.
 */
export async function consumeApproval(id: string): Promise<void> {
  throw new Error(`unbound consumption disabled for ${id}; execute stored intent through executeApproved`);
}

export async function getApproval(id: string): Promise<ApprovalRecord | null> {
  const sb = supabase();
  const { data, error } = await sb
    .from('approvals')
    .select('id, state, decided_by, decided_at, reason, expires_at, executed_at')
    .eq('id', id)
    .eq('org_id', orgId())
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    id: data.id as string,
    state: data.state as ApprovalState,
    decidedBy: (data.decided_by as string | null) ?? null,
    decidedAt: (data.decided_at as string | null) ?? null,
    reason: (data.reason as string | null) ?? null,
    expiresAt: (data.expires_at as string | null) ?? null,
    executedAt: (data.executed_at as string | null) ?? null,
  };
}
