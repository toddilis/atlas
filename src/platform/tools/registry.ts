// Tool registry — registers ToolDefinitions, looks up policy + risk for each invocation,
// dispatches through evaluate() → approval / execute / block, and audits everything.
//
// Phase 0 had a single risk-tier-per-grant gate (auto / notify / approve_required).
// Phase 1 layers the policy engine on top: when a tool has a `policyInput` extractor AND
// a policy_rules row exists for its action, the engine's `evaluate()` produces the
// decision and reasons. Otherwise the legacy risk-tier path runs unchanged — Phase 0
// tools (shopify reads) don't need to know the engine exists.

import { supabase, orgId } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';
import { audit } from '../control-plane/audit.js';
import {
  assertConfiguredCompany, currentPolicySnapshot, encodeActionValue, decodeActionValue,
  prepareBoundApproval, loadBoundAction, claimBoundAction, finishBoundAction,
  stableActionJson, KnownNoEffectError,
} from '../control-plane/bound-actions.js';
import { parseConfig } from '../policy/config.js';
import { assertEffectsAllowed } from '../events/context.js';
import type { RiskTier } from '../control-plane/types.js';
import {
  buildState,
  evaluate,
  loadPolicyConfig,
  type Decision,
  type PolicyInput,
} from '../policy/index.js';

export interface ToolContext {
  /** Trusted deployment binding; arbitrary client tenant selection is never accepted. */
  companyId?: string;
  agentName: string;
  subjectType?: string;
  subjectId?: string | null;
  actionId?: string;
  executionId?: string;
  idempotencyKey?: string;
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
  /** Required for approval of a mutating tool. Read all material preconditions. */
  approvalSnapshot?: (input: I, ctx: ToolContext) => Promise<Record<string, unknown>>;
  /** Declared effect confirmation. A returned handler result alone is not delivery proof. */
  confirmation?: (result: O, input: I, ctx: ToolContext) => Record<string, unknown> | null;
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
 * Validate entitlement and resolve the legacy risk tier for an (agent, tool) pair.
 * Entitlement is mandatory; the returned tier controls dispatch only when no
 * policy_rules row exists for the action.
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
    if (def.mutating) {
      const { error: authorityError } = await sb.rpc('assert_action_authority', {
        p_org_id: orgId(), p_agent: agentName, p_tool: toolName,
      });
      if (authorityError) throw authorityError;
    }
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
 *   0. Validate entitlement. Missing mutation grants and any disabled grant throw
 *      before policy extraction/evaluation, approval creation or execution.
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
  assertEffectsAllowed();
  assertConfiguredCompany(ctx.companyId);
  const def = tools.get(name);
  if (!def) throw new Error(`unknown tool: ${name}`);

  // A policy can constrain an entitled action, but cannot grant tool access.
  // Reuse this lookup's tier on the fallback path; configured policy retains
  // its existing allow/escalate/block precedence after entitlement succeeds.
  const risk = await effectiveRisk(ctx.agentName, name);

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
        const approvalId = await prepareToolApproval(name, input, {
          ...ctx, subjectType: ctx.subjectType ?? policyInput.subjectType,
          subjectId: ctx.subjectId ?? policyInput.subjectId,
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
  if (risk === 'approve_required') {
    const approvalId = await prepareToolApproval(name, input, ctx);
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

async function prepareToolApproval(name: string, input: unknown, ctx: ToolContext): Promise<string> {
  const def = tools.get(name)!;
  if (def.mutating && !def.approvalSnapshot) throw new Error(`tool ${name} has no material-state approval contract`);
  const snapshot = def.approvalSnapshot ? await def.approvalSnapshot(input, ctx) : {};
  const encoded = encodeActionValue(input);
  if (!encoded || Array.isArray(encoded) || typeof encoded !== 'object') throw new Error('tool input must be an object');
  return prepareBoundApproval({ schema_version: 1, org_id: orgId(), agent_name: ctx.agentName,
    tool_name: name, subject_type: ctx.subjectType ?? 'unknown', subject_id: ctx.subjectId ?? null,
    input: encoded, subject_snapshot: encodeActionValue(snapshot) as Record<string, unknown>,
    policy_snapshot: await currentPolicySnapshot(name),
  });
}

export interface ApprovedExecutionContext { companyId: string; actorId: string }
export interface ApprovedExecutionResult<O = unknown> {
  actionId: string; executionId: string; status: 'CONFIRMED' | 'UNRESOLVED'; result: O;
}

/** Executes exclusively the persisted intent. No caller-selected tool, arguments or agent. */
export async function executeApproved<O = unknown>(approvalId: string, trusted: ApprovedExecutionContext): Promise<ApprovedExecutionResult<O>> {
  assertEffectsAllowed();
  assertConfiguredCompany(trusted.companyId);
  if (!trusted.actorId.trim()) throw new Error('trusted executor identity required');
  const stored = await loadBoundAction(approvalId);
  const intent = stored.intent;
  assertConfiguredCompany(intent.org_id);
  const def = tools.get(intent.tool_name);
  if (!def) throw new Error(`unknown stored tool ${intent.tool_name}`);
  if (def.mutating && !def.approvalSnapshot) throw new Error('stored tool lacks material-state contract');
  const input = decodeActionValue(intent.input as Json);
  const ctx: ToolContext = { companyId: intent.org_id, agentName: intent.agent_name,
    subjectType: intent.subject_type, subjectId: intent.subject_id };
  await effectiveRisk(ctx.agentName, intent.tool_name);
  const policy = await currentPolicySnapshot(intent.tool_name);
  if (stableActionJson(policy) !== stableActionJson(intent.policy_snapshot)) throw new Error('policy changed; new approval required');
  if (policy) {
    if (!def.policyInput) throw new Error('policy configured but stored tool has no extractor');
    const decision = evaluate({ action: intent.tool_name, ...def.policyInput(input, ctx) },
      await buildState(intent.tool_name), parseConfig(policy.config));
    if (decision.decision === 'block') throw new Error(`current policy blocks action: ${decision.reasons.join('; ')}`);
    // A still-applicable escalation is precisely the decision this approval authorizes.
  }
  const snapshot = def.approvalSnapshot ? await def.approvalSnapshot(input, ctx) : {};
  if (stableActionJson(encodeActionValue(snapshot)) !== stableActionJson(intent.subject_snapshot)) throw new Error('material subject changed; new approval required');
  const claim = await claimBoundAction(approvalId, trusted.actorId, policy, snapshot);
  if (stableActionJson(claim.intent) !== stableActionJson(intent)) throw new Error('stored action changed during claim');
  Object.assign(ctx, { actionId: claim.action_id, executionId: claim.execution_id, idempotencyKey: claim.idempotency_key });
  let result: unknown;
  try {
    result = await def.execute(input, ctx);
  } catch (error) {
    const known = error instanceof KnownNoEffectError;
    await finishBoundAction(claim.action_id, claim.execution_id, known ? 'FAILED' : 'UNRESOLVED', null,
      known ? error.evidence : null, error instanceof Error ? error.message : String(error));
    throw error;
  }
  // Confirmation failure is itself unresolved, never a free retry of the business effect.
  let evidence: Record<string, unknown> | null = null;
  try { evidence = def.confirmation?.(result, input, ctx) ?? null; } catch { /* unresolved below */ }
  const status = evidence && Object.keys(evidence).length ? 'CONFIRMED' : 'UNRESOLVED';
  await finishBoundAction(claim.action_id, claim.execution_id, status, result, evidence);
  return { actionId: claim.action_id, executionId: claim.execution_id, status, result: result as O };
}
