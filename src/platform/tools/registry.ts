import { supabase, orgId } from '../../data/supabase.js';
import { audit } from '../control-plane/audit.js';
import { requestApproval, getApproval } from '../control-plane/approvals.js';
import type { RiskTier } from '../control-plane/types.js';

export interface ToolContext {
  agentName: string;
  subjectType?: string;
  subjectId?: string | null;
}

export interface ToolDefinition<I, O> {
  name: string;                                              // 'shopify.list_orders'
  /** Default risk tier when no agent-specific grant overrides. */
  defaultRisk: RiskTier;
  /** True when the tool mutates external state (Stripe, Shopify writes, email, etc.). */
  mutating: boolean;
  execute: (input: I, ctx: ToolContext) => Promise<O>;
}

const tools: Map<string, ToolDefinition<unknown, unknown>> = new Map();

export function registerTool<I, O>(def: ToolDefinition<I, O>): void {
  tools.set(def.name, def as ToolDefinition<unknown, unknown>);
}

export function getTool<I, O>(name: string): ToolDefinition<I, O> | undefined {
  return tools.get(name) as ToolDefinition<I, O> | undefined;
}

export function listTools(): string[] {
  return Array.from(tools.keys());
}

/**
 * Look up the effective risk tier for an (agent, tool) pair: explicit grant in tool_grants
 * wins; otherwise the tool's default risk applies. Missing grant for a mutating tool throws.
 */
export async function effectiveRisk(agentName: string, toolName: string): Promise<RiskTier> {
  const def = tools.get(toolName);
  if (!def) throw new Error(`unknown tool: ${toolName}`);

  const sb = supabase();
  const { data, error } = await sb
    .from('tool_grants')
    .select('risk, enabled')
    .eq('org_id', orgId())
    .eq('agent_name', agentName)
    .eq('tool_name', toolName)
    .maybeSingle();
  if (error) throw error;

  if (data) {
    if (!data.enabled) throw new Error(`tool grant disabled: ${agentName} → ${toolName}`);
    return data.risk as RiskTier;
  }
  if (def.mutating) {
    throw new Error(`no tool grant for mutating tool: ${agentName} → ${toolName}`);
  }
  return def.defaultRisk;
}

/**
 * Audit-wrapped tool invocation. For approve_required actions, an approval is requested and
 * the caller must drive it forward (Phase 0 does not block-await operator decisions inline —
 * the calling agent should record activity + return; the operator's decision is delivered
 * via the API in Phase 2).
 *
 * Returns either `{ status: 'executed', result }` or `{ status: 'pending_approval', approvalId }`.
 */
export type InvocationResult<O> =
  | { status: 'executed'; result: O }
  | { status: 'pending_approval'; approvalId: string };

export async function invokeTool<I, O>(
  name: string,
  input: I,
  ctx: ToolContext,
): Promise<InvocationResult<O>> {
  const def = tools.get(name);
  if (!def) throw new Error(`unknown tool: ${name}`);

  const risk = await effectiveRisk(ctx.agentName, name);

  if (risk === 'approve_required') {
    const approvalId = await requestApproval({
      agentName: ctx.agentName,
      action: name,
      subjectType: ctx.subjectType ?? 'unknown',
      subjectId: ctx.subjectId ?? null,
      payload: input as Record<string, unknown>,
      risk,
    });
    await audit({
      agentName: ctx.agentName,
      action: name,
      toolName: name,
      subjectType: ctx.subjectType ?? null,
      subjectId: ctx.subjectId ?? null,
      approvalId,
      risk,
      outcome: 'blocked',
      detail: { reason: 'approval_required' },
    });
    return { status: 'pending_approval', approvalId };
  }

  try {
    const result = (await def.execute(input, ctx)) as O;
    await audit({
      agentName: ctx.agentName,
      action: name,
      toolName: name,
      subjectType: ctx.subjectType ?? null,
      subjectId: ctx.subjectId ?? null,
      risk,
      outcome: 'success',
    });
    return { status: 'executed', result };
  } catch (e) {
    await audit({
      agentName: ctx.agentName,
      action: name,
      toolName: name,
      subjectType: ctx.subjectType ?? null,
      subjectId: ctx.subjectId ?? null,
      risk,
      outcome: 'failure',
      detail: { error: (e as Error).message },
    });
    throw e;
  }
}

/**
 * After an approval is granted, callers use this to actually execute the previously-blocked
 * tool. The approval id must point to an approved row; otherwise this throws.
 */
export async function executeApproved<I, O>(
  approvalId: string,
  name: string,
  input: I,
  ctx: ToolContext,
): Promise<O> {
  const approval = await getApproval(approvalId);
  if (!approval) throw new Error(`approval not found: ${approvalId}`);
  if (approval.state !== 'approved') {
    throw new Error(`approval not in approved state: ${approval.state}`);
  }
  const def = tools.get(name);
  if (!def) throw new Error(`unknown tool: ${name}`);

  try {
    const result = (await def.execute(input, ctx)) as O;
    await audit({
      agentName: ctx.agentName,
      action: name,
      toolName: name,
      subjectType: ctx.subjectType ?? null,
      subjectId: ctx.subjectId ?? null,
      approvalId,
      risk: 'approve_required',
      outcome: 'success',
    });
    return result;
  } catch (e) {
    await audit({
      agentName: ctx.agentName,
      action: name,
      toolName: name,
      subjectType: ctx.subjectType ?? null,
      subjectId: ctx.subjectId ?? null,
      approvalId,
      risk: 'approve_required',
      outcome: 'failure',
      detail: { error: (e as Error).message },
    });
    throw e;
  }
}
