import { supabase, orgId } from '../../data/supabase.js';
import type { RiskTier } from '../control-plane/types.js';

export interface ToolGrant {
  agentName: string;
  toolName: string;
  risk: RiskTier;
  enabled?: boolean;
}

/** Upsert a single agent→tool grant. Idempotent. */
export async function grantTool(grant: ToolGrant): Promise<void> {
  const sb = supabase();
  const { error } = await sb
    .from('tool_grants')
    .upsert(
      {
        org_id: orgId(),
        agent_name: grant.agentName,
        tool_name: grant.toolName,
        risk: grant.risk,
        enabled: grant.enabled ?? true,
      },
      { onConflict: 'org_id,agent_name,tool_name' },
    );
  if (error) throw error;
}

export async function grantTools(grants: ToolGrant[]): Promise<void> {
  for (const g of grants) await grantTool(g);
}
