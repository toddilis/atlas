// Tool registry — registers ToolDefinitions, looks up policy + risk for each invocation,
// dispatches through evaluate() → approval / execute / block, and audits everything.
//
// Phase 0 had a single risk-tier-per-grant gate (auto / notify / approve_required).
// Phase 1 layers the policy engine on top: when a tool has a `policyInput` extractor AND
// a policy_rules row exists for its action, the engine's `evaluate()` produces the
// decision and reasons. Otherwise the legacy risk-tier path runs unchanged — Phase 0
// tools (shopify reads) don't need to know the engine exists.

import { supabase, orgId } from '../../data/supabase.js';
import { audit } from '../control-plane/audit.js';
import { requestApproval, consumeApproval } from '../control-plane/approvals.js';
import type { RiskTier } from '../control-plane/types.js';
import {
  buildState,
  evaluate,
  loadPolicyConfig,
  type Decision,
  type PolicyInput,
} from '../policy/index.js';

export interface ToolContext {
  agentName: string;
  subjectType?: string;
  subjectId?: string | null;
}

export interface ToolDefinition<I, O> {
  name: string;
  defaultRisk: RiskTier;
  mutating: boolean;
  /**
   * Optional extractor that maps the raw tool input into the engine-shaped PolicyInput.
   * When provided AND a policy_rules row exists for `name`, invokeTool consults the
   * engine before deciding the outcome. When absent (e.g. read-only Shopify tools), the
   * legacy risk-tier path is used.
   *
   * The extractor MUST be deterministic and side-effect-free — it's called inside the
   * audit pipeline.
   */
  policyInput?: (input: I, ctx: ToolContext) => Omit<PolicyInput, 'action'>;
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
 * Look up the effective risk tier for an (agent, tool) pair from the legacy grant table.
 * Used as fallback when no policy_rules row exists for the action.
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
 * Mapping from a policy decision to the legacy risk tier that the audit/approval row
 * expects. Used so audit_log/approvals stay populated with a sensible risk regardless
 * of which path was taken.
 */
function riskForDecision(d: Decision): RiskTier {
  switch (d.decision) {
    case 'allow':
      return 'auto';
    case 'escalate':
      return 'approve_required';
    case 'block':
      return 'approve_required';
  }
}

export type InvocationResult<O> =
  | { status: 'executed'; result: O; decision: Decision | null }
  | { status: 'pending_approval'; approvalId: string; decision: Decision }
  | { status: 'blocked'; decision: Decision };

/**
 * Invoke a tool. The dispatch:
 *   1. If the tool has a `policyInput` extractor AND a policy_rules row exists for the
 *      action, run evaluate() and switch on the decision:
 *        allow    → execute → audit success
 *        escalate → request approval → audit blocked(reason=escalate)
 *        block    → audit blocked(reason=policy_block) → return without executing
 *   2. Else, fall back to the legacy risk-tier path (auto → execute; approve_required →
 *      request approval; notify → execute + record).
 */
export async function invokeTool<I, O>(
  name: string,
  input: I,
  ctx: ToolContext,
): Promise<InvocationResult<O>> {
  const def = tools.get(name);
  if (!def) throw new Error(`unknown tool: ${name}`);

  // ---------- policy-engine path ----------
  if (def.policyInput) {
    const cfg = await loadPolicyConfig(name);
    if (cfg) {
      const partial = def.policyInput(input as I, ctx);
      const policyInput: PolicyInput = { action: name, ...partial };
      const state = await buildState(name);
      const decision = evaluate(policyInput, state, cfg);
      const risk = riskForDecision(decision);

      if (decision.decision === 'block') {
        await audit({
          agentName: ctx.agentName,
          action: name,
          toolName: name,
          subjectType: ctx.subjectType ?? null,
          subjectId: ctx.subjectId ?? null,
          risk,
          outcome: 'blocked',
          detail: { reasons: decision.reasons },
        });
        return { status: 'blocked', decision };
      }

      if (decision.decision === 'escalate') {
        const approvalId = await requestApproval({
          agentName: ctx.agentName,
          action: name,
          subjectType: ctx.subjectType ?? policyInput.subjectType,
          subjectId: ctx.subjectId ?? policyInput.subjectId,
          payload: { input, decision } as Record<string, unknown>,
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
          detail: { reasons: decision.reasons, reason: 'approval_required' },
        });
        return { status: 'pending_approval', approvalId, decision };
      }

      // allow → execute
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
          detail: { reasons: decision.reasons },
        });
        return { status: 'executed', result, decision };
      } catch (e) {
        await audit({
          agentName: ctx.agentName,
          action: name,
          toolName: name,
          subjectType: ctx.subjectType ?? null,
          subjectId: ctx.subjectId ?? null,
          risk,
          outcome: 'failure',
          detail: { reasons: decision.reasons, error: (e as Error).message },
        });
        throw e;
      }
    }
    // fall through to legacy path if no policy row matches
  }

  // ---------- legacy risk-tier path (unchanged from Phase 0) ----------
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
    return {
      status: 'pending_approval',
      approvalId,
      decision: { decision: 'escalate', reasons: ['[risk-tier] approve_required'] },
    };
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
    return { status: 'executed', result, decision: null };
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
 * tool. The approval is CONSUMED first (single-use compare-and-swap on executed_at, with
 * expiry enforced) — a second call with the same approval id throws, and a failed execution
 * spends the approval rather than leaving it silently replayable (PR-L).
 */
export async function executeApproved<I, O>(
  approvalId: string,
  name: string,
  input: I,
  ctx: ToolContext,
): Promise<O> {
  const def = tools.get(name);
  if (!def) throw new Error(`unknown tool: ${name}`);
  await consumeApproval(approvalId);

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
