import { supabase, orgId } from '../../data/supabase.js';
import { log } from '../log.js';
import type { AppendedEvent, EventType } from './types.js';
import { EVENT_COLUMNS, toAppendedEvent } from './row.js';

export type Projector = (event: AppendedEvent) => Promise<void>;

const registry: Map<EventType, Projector[]> = new Map();

/**
 * Automatic-replay attempt cap. An event that fails this many dispatches goes 'dead': the
 * replay loop stops retrying it and it surfaces on the dashboard instead. Explicit provider
 * redelivery still re-dispatches dead events — a fixed root cause lets them heal.
 */
export const MAX_PROJECTION_ATTEMPTS = 10;

/** Don't replay a 'pending' row younger than this — its first dispatch may be in flight. */
export const PENDING_GRACE_MS = 60_000;

export function registerProjector(type: EventType, fn: Projector): void {
  const existing = registry.get(type) ?? [];
  existing.push(fn);
  registry.set(type, existing);
}

export async function dispatch(event: AppendedEvent): Promise<void> {
  const projectors = registry.get(event.type) ?? [];
  for (const p of projectors) {
    try {
      await p(event);
    } catch (e) {
      log.error('projector.failed', {
        type: event.type,
        seq: event.seq,
        error: (e as Error).message,
      });
      throw e;
    }
  }
}

export interface ProjectionOutcome {
  projected: boolean;
  error?: string;
}

/**
 * Dispatch an event's projectors and record the outcome on its event_projections row
 * (created by the 0017 trigger in the same transaction as the append). Never throws —
 * the caller decides what a failure means (webhook → non-2xx so the provider retries;
 * replay → move on to the next event).
 */
export async function dispatchTracked(
  event: AppendedEvent,
  priorAttempts: number,
): Promise<ProjectionOutcome> {
  const sb = supabase();
  const attempts = priorAttempts + 1;
  try {
    await dispatch(event);
    const { error } = await sb
      .from('event_projections')
      .update({ state: 'projected', attempts, last_error: null, updated_at: new Date().toISOString() })
      .eq('event_id', event.id);
    if (error) {
      // The projection itself succeeded; only the bookkeeping write failed. Replay will
      // re-dispatch (idempotent) and re-attempt the mark, so log rather than fail the caller.
      log.error('event_projections.mark_projected_failed', { event_id: event.id, error: error.message });
    }
    return { projected: true };
  } catch (e) {
    const message = (e as Error).message;
    const state = attempts >= MAX_PROJECTION_ATTEMPTS ? 'dead' : 'failed';
    const { error } = await sb
      .from('event_projections')
      .update({ state, attempts, last_error: message, updated_at: new Date().toISOString() })
      .eq('event_id', event.id);
    if (error) {
      log.error('event_projections.mark_failed_failed', { event_id: event.id, error: error.message });
    }
    log.error('event_log.projection_failed', {
      seq: event.seq,
      type: event.type,
      attempts,
      state,
      error: message,
    });
    return { projected: false, error: message };
  }
}

interface ProjectionStateRow {
  state: string;
  attempts: number;
  updatedAt: string;
}

/** Fetch an event's projection-state row. Null for pre-0017 rows that somehow lack one. */
export async function getProjectionState(eventId: string): Promise<ProjectionStateRow | null> {
  const sb = supabase();
  const { data, error } = await sb
    .from('event_projections')
    .select('state, attempts, updated_at')
    .eq('event_id', eventId)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return {
    state: data.state as string,
    attempts: Number(data.attempts ?? 0),
    updatedAt: data.updated_at as string,
  };
}

/**
 * Pure eligibility rule for the automatic replay loop — exported for tests.
 * 'failed' rows are always eligible below the attempt cap; 'pending' rows only after a
 * grace period (their first dispatch may still be in flight); 'projected' and 'dead' never.
 */
export function replayEligible(
  row: { state: string; attempts: number; updatedAt: string },
  now: Date,
  graceMs: number = PENDING_GRACE_MS,
  maxAttempts: number = MAX_PROJECTION_ATTEMPTS,
): boolean {
  if (row.attempts >= maxAttempts) return false;
  if (row.state === 'failed') return true;
  if (row.state === 'pending') {
    return now.getTime() - new Date(row.updatedAt).getTime() >= graceMs;
  }
  return false;
}

export interface ReplaySummary {
  scanned: number;
  projected: number;
  failed: number;
  dead: number;
}

/**
 * Re-drive outstanding projections in seq order. Two modes:
 *
 * - Default: drain the outstanding queue — every event whose projection is 'failed', or
 *   'pending' older than the grace period, below the attempt cap. This is the durability
 *   backstop the worker (PR-R) runs on a schedule.
 * - `fromSeq`: re-dispatch ALL events from a sequence number regardless of state — rebuilds
 *   canonical read-models after a projector change. Safe because projectors are idempotent.
 *
 * Events are processed strictly by seq so read-models converge in append order. A failure
 * records its outcome and moves on — one poisoned event doesn't block the queue behind it,
 * it just stays visible until fixed or dead.
 */
export async function replay(opts: { limit?: number; fromSeq?: number } = {}): Promise<ReplaySummary> {
  const sb = supabase();
  const limit = opts.limit ?? 100;
  const summary: ReplaySummary = { scanned: 0, projected: 0, failed: 0, dead: 0 };

  let rows: Array<{ attempts: number; event: Record<string, unknown> }> = [];

  if (opts.fromSeq != null) {
    const { data, error } = await sb
      .from('event_log')
      .select(EVENT_COLUMNS)
      .eq('org_id', orgId())
      .gte('seq', opts.fromSeq)
      .order('seq', { ascending: true })
      .limit(limit);
    if (error) throw error;
    const events = (data ?? []) as Array<Record<string, unknown>>;
    const states = await Promise.all(
      events.map((e) => getProjectionState(e.id as string)),
    );
    rows = events.map((event, i) => ({ attempts: states[i]?.attempts ?? 0, event }));
  } else {
    const graceCutoff = new Date(Date.now() - PENDING_GRACE_MS).toISOString();
    const { data, error } = await sb
      .from('event_projections')
      .select(`state, attempts, updated_at, event_log(${EVENT_COLUMNS})`)
      .eq('org_id', orgId())
      .neq('state', 'projected')
      .neq('state', 'dead')
      .lt('attempts', MAX_PROJECTION_ATTEMPTS)
      .or(`state.eq.failed,updated_at.lt.${graceCutoff}`)
      .order('seq', { ascending: true })
      .limit(limit);
    if (error) throw error;
    rows = ((data ?? []) as Array<Record<string, unknown>>)
      .filter((r) => r.event_log != null)
      .map((r) => ({
        attempts: Number(r.attempts ?? 0),
        event: r.event_log as Record<string, unknown>,
      }));
  }

  for (const row of rows) {
    summary.scanned += 1;
    const outcome = await dispatchTracked(toAppendedEvent(row.event), row.attempts);
    if (outcome.projected) {
      summary.projected += 1;
    } else if (row.attempts + 1 >= MAX_PROJECTION_ATTEMPTS) {
      summary.dead += 1;
    } else {
      summary.failed += 1;
    }
  }

  if (summary.scanned > 0) {
    log.info('projector.replay', summary as unknown as Record<string, unknown>);
  }
  return summary;
}
