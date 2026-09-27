import { z } from 'zod';
import { supabase, orgId } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';
import { assertEffectsAllowed } from '../events/context.js';

/** Tagged bigint is restricted to this codec; callers cannot smuggle a tagged object. */
export function encodeActionValue(value: unknown): Json {
  if (typeof value === 'bigint') return { $atlas_bigint: value.toString() };
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || (Number.isInteger(value) && !Number.isSafeInteger(value))) throw new Error('unsafe numeric action input');
    return value;
  }
  if (Array.isArray(value)) return value.map(encodeActionValue);
  if (typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    if (Object.hasOwn(value, '$atlas_bigint')) throw new Error('reserved bigint tag in action input');
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, encodeActionValue(child)]));
  }
  throw new Error('action values must be JSON values or bigint; undefined/classes are not accepted');
}

export function decodeActionValue(value: Json): unknown {
  if (Array.isArray(value)) return value.map(decodeActionValue);
  if (value !== null && typeof value === 'object') {
    if (Object.hasOwn(value, '$atlas_bigint')) {
      if (Object.keys(value).length !== 1 || typeof value.$atlas_bigint !== 'string' || !/^-?(0|[1-9][0-9]*)$/.test(value.$atlas_bigint))
        throw new Error('invalid persisted bigint');
      return BigInt(value.$atlas_bigint);
    }
    return Object.fromEntries(Object.entries(value).map(([key, child]) => [key, decodeActionValue(child!)]));
  }
  return value;
}

export function stableActionJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableActionJson).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${stableActionJson(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

export const StoredActionIntent = z.object({
  schema_version: z.literal(1), org_id: z.string().uuid(), agent_name: z.string().min(1),
  tool_name: z.string().min(1), subject_type: z.string().min(1), subject_id: z.string().uuid().nullable(),
  input: z.record(z.unknown()), subject_snapshot: z.record(z.unknown()),
  policy_snapshot: z.object({ id: z.string().uuid(), version: z.number().int().positive(), config: z.record(z.unknown()) }).strict().nullable(),
}).strict();
export type StoredActionIntent = z.infer<typeof StoredActionIntent>;

/** This boundary is for a trusted server/job context, not a browser-supplied tenant. */
export function assertConfiguredCompany(companyId: string | undefined): string {
  const configured = orgId();
  if (companyId !== undefined && companyId !== configured) throw new Error('company does not match trusted deployment binding');
  return configured;
}

export async function currentPolicySnapshot(tool: string): Promise<StoredActionIntent['policy_snapshot']> {
  const { data, error } = await supabase().rpc('current_action_policy', { p_org_id: orgId(), p_tool: tool });
  if (error) throw error;
  return StoredActionIntent.shape.policy_snapshot.parse(data);
}

export async function prepareBoundApproval(intent: StoredActionIntent, summary?: string): Promise<string> {
  assertEffectsAllowed();
  assertConfiguredCompany(intent.org_id);
  StoredActionIntent.parse(intent);
  const ttl = Number(process.env.ATLAS_APPROVAL_TTL_SECONDS ?? '3600');
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > 86400) throw new Error('approval TTL must be 1..86400 seconds');
  const { data, error } = await supabase().rpc('create_bound_approval', {
    p_org_id: intent.org_id, p_intent: intent as unknown as Json,
    p_expires_at: new Date(Date.now() + ttl * 1000).toISOString(), p_summary: summary ?? null,
  });
  if (error) throw error;
  return z.string().uuid().parse(data);
}

export async function loadBoundAction(approvalId: string) {
  const { data, error } = await supabase().from('approved_actions').select('*')
    .eq('org_id', orgId()).eq('approval_id', approvalId).maybeSingle();
  if (error) throw error;
  if (!data) throw new Error('bound action not found; legacy approvals require a fresh proposal');
  return { ...data, intent: StoredActionIntent.parse(data.intent) };
}

export async function claimBoundAction(approvalId: string, actorId: string, policy: StoredActionIntent['policy_snapshot'], snapshot: Record<string, unknown>) {
  const { data, error } = await supabase().rpc('claim_bound_action', {
    p_org_id: orgId(), p_approval_id: approvalId, p_actor: actorId,
    p_policy_snapshot: policy as unknown as Json, p_subject_snapshot: encodeActionValue(snapshot),
  });
  if (error) throw error;
  return z.object({ action_id: z.string().uuid(), execution_id: z.string().uuid(), idempotency_key: z.string().min(1), intent: StoredActionIntent }).parse(data);
}

export class KnownNoEffectError extends Error {
  constructor(message: string, readonly evidence: Record<string, unknown>) { super(message); }
}

export async function finishBoundAction(actionId: string, executionId: string, state: 'CONFIRMED' | 'FAILED' | 'UNRESOLVED',
  result: unknown, evidence: Record<string, unknown> | null, errorMessage?: string) {
  const { error } = await supabase().rpc('finish_bound_action', {
    p_org_id: orgId(), p_action_id: actionId, p_execution_id: executionId, p_state: state,
    p_result: encodeActionValue(result), p_evidence: evidence === null ? null : encodeActionValue(evidence), p_error: errorMessage ?? null,
  });
  if (error) throw error;
}

export async function invoiceApprovalSnapshot(invoiceId: string) {
  const { data, error } = await supabase().rpc('invoice_action_snapshot', { p_org_id: orgId(), p_invoice_id: invoiceId });
  if (error) throw error;
  if (!data) throw new Error('invoice not found in current company');
  return z.record(z.unknown()).parse(data);
}
