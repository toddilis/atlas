import { randomUUID } from 'node:crypto';
import { supabase, orgId } from '../../data/supabase.js';
import { log } from '../log.js';
import { executeApproved } from './registry.js';
import { loadBoundAction } from '../control-plane/bound-actions.js';
import { assertEffectsAllowed } from '../events/context.js';

export interface OutboxEnqueueInput {
  toolName: string;
  action: string;
  payload: Record<string, unknown>;
  /** Caller-supplied dedup key; if absent, a uuid is generated. */
  idempotencyKey?: string;
  relatedSubjectType?: string;
  relatedSubjectId?: string | null;
  /** A persisted approval for exactly the queued provider action, never inherited implicitly. */
  approvalId?: string;
}

export interface OutboxRow {
  id: string;
  toolName: string;
  action: string;
  payload: Record<string, unknown>;
  idempotencyKey: string;
  state: 'pending' | 'in_flight' | 'sent' | 'failed' | 'dead';
  attempts: number;
}

/**
 * Enqueue a reliable external side-effect. The DB write that depends on the side-effect (e.g.
 * creating an invoice row) and this enqueue should be in the same DB transaction so they
 * either both land or neither does (transactional outbox pattern).
 */
export async function enqueue(input: OutboxEnqueueInput): Promise<string> {
  assertEffectsAllowed();
  if (!input.approvalId) throw new Error('outbox enqueue requires a bound provider action approval');
  const action = await loadBoundAction(input.approvalId);
  if (action.intent.tool_name !== input.toolName) throw new Error('outbox tool differs from approved action');
  const sb = supabase();
  const idempotencyKey = `${orgId()}:${input.idempotencyKey ?? randomUUID()}`;
  const { data, error } = await sb
    .from('outbox')
    .insert({
      org_id: orgId(),
      tool_name: input.toolName,
      action: input.action,
      payload: { approval_id: input.approvalId, company_id: orgId() },
      idempotency_key: idempotencyKey,
      related_subject_type: input.relatedSubjectType ?? null,
      related_subject_id: input.relatedSubjectId ?? null,
    })
    .select('id')
    .single();

  if (error) {
    if (error.code === '23505') {
      // Idempotency key conflict — return the existing row id, treat as no-op.
      const prior = await sb
        .from('outbox')
        .select('id')
        .eq('org_id', orgId())
        .eq('idempotency_key', idempotencyKey)
        .single();
      if (prior.error || !prior.data) throw error;
      return prior.data.id as string;
    }
    throw error;
  }

  return data.id as string;
}

/** How long an in_flight lease may sit before it's presumed crashed and reaped. */
export const LEASE_TTL_MS = 5 * 60_000;

/**
 * A lost lease does not prove that the provider did nothing. Quarantine it for
 * reconciliation rather than returning it to executable work.
 */
export async function reapStaleLeases(): Promise<number> {
  assertEffectsAllowed();
  const sb = supabase();
  const cutoff = new Date(Date.now() - LEASE_TTL_MS).toISOString();
  const now = new Date().toISOString();
  const { data, error } = await sb
    .from('outbox')
    .update({
      state: 'failed',
      next_attempt_at: now,
      last_error: 'RECONCILIATION_REQUIRED: lease expired with unknown external result',
      updated_at: now,
    })
    .eq('org_id', orgId())
    .eq('state', 'in_flight')
    .lt('updated_at', cutoff)
    .select('id');
  if (error) throw error;
  const reaped = data?.length ?? 0;
  if (reaped > 0) log.warn('outbox.leases_reaped', { count: reaped });
  return reaped;
}

/**
 * Drain pending outbox rows up to `limit`. Returns the number of rows processed. Caller is
 * responsible for the schedule (cron / setInterval / etc.). Each row is leased by flipping
 * state to `in_flight` before executing the stored approved action. Unknown outcomes
 * and stale leases are held for reconciliation; they never become automatic retries.
 */
export async function drain(limit = 25): Promise<number> {
  assertEffectsAllowed();
  const sb = supabase();
  await reapStaleLeases();
  const { data: rows, error } = await sb
    .from('outbox')
    .select('*')
    .eq('org_id', orgId())
    .eq('state', 'pending')
    .lte('next_attempt_at', new Date().toISOString())
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  if (!rows || rows.length === 0) return 0;

  let processed = 0;
  for (const row of rows) {
    // Lease the row.
    const lease = await sb
      .from('outbox')
      .update({ state: 'in_flight', attempts: (row.attempts as number) + 1, updated_at: new Date().toISOString() })
      .eq('id', row.id)
      .eq('org_id', orgId())
      .eq('state', 'pending')
      .select('id')
      .maybeSingle();
    if (lease.error || !lease.data) continue;             // someone else took it

    const payload = row.payload as Record<string, unknown>;
    if (typeof payload.approval_id !== 'string' || payload.company_id !== orgId()) {
      await markFailed(row.id as string, 'BOUND_APPROVAL_REQUIRED: legacy/unbound outbox held for operator reconciliation');
      continue;
    }

    try {
      const stored = await loadBoundAction(payload.approval_id);
      if (stored.intent.tool_name !== row.tool_name || stored.intent.subject_id !== row.related_subject_id)
        throw new Error('outbox binding differs from stored action');
      const result = await executeApproved(payload.approval_id, { companyId: orgId(), actorId: 'trusted-outbox-worker' });
      const { error: saveError } = await sb
        .from('outbox')
        .update({
          state: result.status === 'CONFIRMED' ? 'sent' : 'failed',
          result: { action_id: result.actionId, execution_id: result.executionId, status: result.status },
          last_error: result.status === 'CONFIRMED' ? null : 'RECONCILIATION_REQUIRED: effect not confirmed',
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id).eq('org_id', orgId());
      if (saveError) throw saveError;
      processed++;
    } catch (e) {
      await markFailed(row.id, `RECONCILIATION_REQUIRED: ${(e as Error).message}`);
      log.warn('outbox.attempt_failed', { id: row.id, error: (e as Error).message });
    }
  }
  return processed;
}

async function markFailed(id: string, error: string): Promise<void> {
  const sb = supabase();
  const { error: saveError } = await sb
    .from('outbox')
    .update({ state: 'failed', last_error: error, updated_at: new Date().toISOString() })
    .eq('id', id).eq('org_id', orgId());
  if (saveError) throw saveError;
}
