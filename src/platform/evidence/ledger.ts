import { z } from 'zod';
import { supabase, orgId } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';
import { ObservationV1, DecisionV1, OutcomeV1 } from '../contracts/controller-v1.js';
import { assertEventCompany } from '../events/delivery.js';
import { assertEffectsAllowed } from '../events/context.js';

function evidenceJson(value: unknown): Json {
  assertEventCompany(value);
  const text = JSON.stringify(value, (_key, child: unknown) => {
    if (typeof child === 'number' && (!Number.isFinite(child) || (Number.isInteger(child) && !Number.isSafeInteger(child))))
      throw new Error('unsafe evidence number; use exact monetary strings');
    if (child === undefined || typeof child === 'bigint') throw new Error('evidence must be lossless JSON');
    return child;
  });
  if (Buffer.byteLength(text) > 262144) throw new Error('evidence exceeds 256 KiB');
  return JSON.parse(text) as Json;
}

export async function recordObservation(input: unknown, facts: Record<string, unknown>) {
  assertEffectsAllowed();
  const record = ObservationV1.parse(input);
  const { data, error } = await supabase().rpc('record_evidence_observation', {
    p_org_id: orgId(), p_record: evidenceJson(record), p_facts: evidenceJson(facts),
  });
  if (error) throw error;
  return data;
}

export async function recordDecision(input: unknown, stateAtDecision: Record<string, unknown>) {
  assertEffectsAllowed();
  const record = DecisionV1.parse(input);
  const { data, error } = await supabase().rpc('record_evidence_decision', {
    p_org_id: orgId(), p_record: evidenceJson(record), p_state_snapshot: evidenceJson(stateAtDecision),
  });
  if (error) throw error;
  return data;
}

export async function linkDecisionAction(decisionId: string, revision: number, actionId: string) {
  assertEffectsAllowed();
  const { error } = await supabase().rpc('link_decision_action', {
    p_org_id: orgId(), p_decision_id: decisionId, p_revision: z.number().int().positive().parse(revision), p_action_id: z.string().uuid().parse(actionId),
  });
  if (error) throw error;
}

export async function recordOutcome(input: unknown, decisionRevision: number) {
  assertEffectsAllowed();
  const record = OutcomeV1.parse(input);
  const { data, error } = await supabase().rpc('record_evidence_outcome', {
    p_org_id: orgId(), p_decision_revision: z.number().int().positive().parse(decisionRevision), p_record: evidenceJson(record),
  });
  if (error) throw error;
  return data;
}

/** Server-only read seam. Absence is null; it never fabricates missing evidence. */
export async function readDecisionEvidence(decisionId: string, revision: number) {
  const { data, error } = await supabase().rpc('read_decision_evidence', {
    p_org_id: orgId(), p_decision_id: z.string().min(1).parse(decisionId), p_revision: z.number().int().positive().parse(revision),
  });
  if (error) throw error;
  return data;
}
