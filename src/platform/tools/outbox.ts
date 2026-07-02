import { randomUUID } from 'node:crypto';
import { supabase, orgId } from '../../data/supabase.js';
import { log } from '../log.js';
import { getTool } from './registry.js';

export interface OutboxEnqueueInput {
  toolName: string;
  action: string;
  payload: Record<string, unknown>;
  /** Caller-supplied dedup key; if absent, a uuid is generated. */
  idempotencyKey?: string;
  relatedSubjectType?: string;
  relatedSubjectId?: string | null;
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
  const sb = supabase();
  const idempotencyKey = input.idempotencyKey ?? randomUUID();
  const { data, error } = await sb
    .from('outbox')
    .insert({
      org_id: orgId(),
      tool_name: input.toolName,
      action: input.action,
      payload: input.payload,
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
 * Recover rows stranded in `in_flight` by a crash between lease and terminal update (PR-L:
 * previously nothing ever re-scanned them, so they were stuck forever). Reaped rows return
 * to `pending` and re-execute on the next drain — safe because tool side-effects are
 * externally idempotent (e.g. Stripe idempotency keys derived from the invoice id), so a
 * lease whose external call actually succeeded re-executes to the same result.
 */
export async function reapStaleLeases(): Promise<number> {
  const sb = supabase();
  const cutoff = new Date(Date.now() - LEASE_TTL_MS).toISOString();
  const now = new Date().toISOString();
  const { data, error } = await sb
    .from('outbox')
    .update({
      state: 'pending',
      next_attempt_at: now,
      last_error: 'lease expired; reaped back to pending',
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
 * state to `in_flight` before calling the tool — exactly-once relies on the tool's external
 * idempotency (Stripe idempotency-key, etc.). Stale leases from crashed drains are reaped
 * back to `pending` first.
 */
export async function drain(limit = 25): Promise<number> {
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
      .eq('state', 'pending')
      .select('id')
      .maybeSingle();
    if (lease.error || !lease.data) continue;             // someone else took it

    const tool = getTool(row.tool_name as string);
    if (!tool) {
      await markFailed(row.id as string, `unknown tool: ${row.tool_name}`);
      continue;
    }

    try {
      const result = await tool.execute(row.payload as Record<string, unknown>, {
        agentName: 'outbox',
        subjectType: (row.related_subject_type as string | null) ?? undefined,
        subjectId: (row.related_subject_id as string | null) ?? null,
      });
      await sb
        .from('outbox')
        .update({
          state: 'sent',
          result: result as Record<string, unknown>,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      processed++;
    } catch (e) {
      const attempts = (row.attempts as number) + 1;
      const dead = attempts >= 8;
      await sb
        .from('outbox')
        .update({
          state: dead ? 'dead' : 'pending',
          next_attempt_at: dead ? null : nextBackoff(attempts).toISOString(),
          last_error: (e as Error).message,
          updated_at: new Date().toISOString(),
        })
        .eq('id', row.id);
      log.warn('outbox.attempt_failed', { id: row.id, attempts, error: (e as Error).message });
    }
  }
  return processed;
}

function nextBackoff(attempts: number): Date {
  // 2^attempts seconds, capped at 1 hour.
  const seconds = Math.min(2 ** attempts, 3600);
  return new Date(Date.now() + seconds * 1000);
}

async function markFailed(id: string, error: string): Promise<void> {
  const sb = supabase();
  await sb
    .from('outbox')
    .update({ state: 'failed', last_error: error, updated_at: new Date().toISOString() })
    .eq('id', id);
}
