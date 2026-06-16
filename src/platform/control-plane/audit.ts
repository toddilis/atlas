import { supabase, orgId } from '../../data/supabase.js';
import type { AuditOutcome, RiskTier } from './types.js';

export interface AuditInput {
  agentName: string;
  action: string;
  toolName?: string | null;
  subjectType?: string | null;
  subjectId?: string | null;
  approvalId?: string | null;
  risk: RiskTier;
  outcome: AuditOutcome;
  detail?: Record<string, unknown>;
}

/**
 * Append an immutable record to the audit log. Every mutating action attempted by an agent —
 * allowed, blocked, or failed — passes through here.
 */
export async function audit(input: AuditInput): Promise<void> {
  const sb = supabase();
  const { error } = await sb.from('audit_log').insert({
    org_id: orgId(),
    agent_name: input.agentName,
    action: input.action,
    tool_name: input.toolName ?? null,
    subject_type: input.subjectType ?? null,
    subject_id: input.subjectId ?? null,
    approval_id: input.approvalId ?? null,
    risk: input.risk,
    outcome: input.outcome,
    detail: input.detail ?? null,
  });
  if (error) throw error;
}
