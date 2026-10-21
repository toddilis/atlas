import { supabase } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';
import { log } from '../log.js';

// JOBS-01 runner core shared by every job kind. The database owns discovery, leases,
// backoff, quarantine and whether a job is still needed (0029, 0035); a pass only claims
// due jobs of one kind, runs each, and reports how its attempt ended.

export type JobKind = 'carrier_cost_sync' | 'invoice_part_draft' | 'shopify_sync' | 'approved_action_execute' | 'daily_briefing';
export type Job = { org_id: string | null; job_key: string | null; source_id: string | null; dispatch_id: string | null; action_id: string | null; lease_token: string | null; attempts: number };
export type JobOutcome = 'succeeded' | 'retry' | 'blocked';
export interface JobsStore {
  discover(orgId: string): Promise<number>;
  claim(orgId: string): Promise<Job | null>;
  finish(orgId: string, job: Job, outcome: JobOutcome, detail: Record<string, unknown>): Promise<string>;
}

const DISCOVER = { carrier_cost_sync: 'discover_carrier_cost_jobs', invoice_part_draft: 'discover_invoice_part_jobs',
  shopify_sync: 'discover_shopify_sync_jobs', approved_action_execute: 'discover_approved_action_jobs',
  daily_briefing: 'discover_daily_briefing_jobs' } as const;

export function scheduledJobs(kind: JobKind): JobsStore {
  return {
    async discover(orgId) {
      const { data, error } = await supabase().rpc(DISCOVER[kind], { p_org_id: orgId });
      if (error) throw error;
      return data ?? 0;
    },
    async claim(orgId) {
      const { data, error } = await supabase().rpc('claim_scheduled_job', { p_org_id: orgId, p_kind: kind });
      if (error) throw error;
      return data && data.job_key ? data as Job : null;
    },
    async finish(orgId, job, outcome, detail) {
      const { data, error } = await supabase().rpc('finish_scheduled_job', { p_org_id: orgId, p_job_key: job.job_key!,
        p_lease_token: job.lease_token!, p_outcome: outcome, p_detail: detail as Json });
      if (error) throw error;
      return data;
    },
  };
}

// Supabase RPC errors are plain objects with a message, not Error instances.
export const messageOf = (error: unknown) =>
  error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : String(error);

export type PassResult = { discovered: number; succeeded: number; retrying: number; blocked: number; quarantined: number; unfinished: number };

/** One pass for a business: discover, then run up to `limit` due jobs. A run that cannot
 * be finished (its lease expired, or the database is unavailable) is left to lease expiry
 * and recorded on the next pass; the other due jobs still run. */
export async function runJobPass(orgId: string, store: JobsStore, run: (job: Job) => Promise<Record<string, unknown>>,
  classify: (error: unknown) => 'retry' | 'blocked', limit = 20): Promise<PassResult> {
  const result: PassResult = { discovered: await store.discover(orgId), succeeded: 0, retrying: 0, blocked: 0, quarantined: 0, unfinished: 0 };
  for (let n = 0; n < limit; n++) {
    const job = await store.claim(orgId);
    if (!job) break;
    let outcome: JobOutcome; let detail: Record<string, unknown>;
    try { detail = await run(job); outcome = 'succeeded'; }
    catch (e) { outcome = classify(e); detail = { error: messageOf(e) }; }
    let state: string;
    try { state = await store.finish(orgId, job, outcome, detail); }
    catch (e) { log.error('jobs.finish_failed', { job_key: job.job_key, outcome, error: messageOf(e) }); result.unfinished++; continue; }
    if (state === 'succeeded') result.succeeded++; else if (state === 'quarantined') result.quarantined++;
    else if (state === 'blocked') result.blocked++; else result.retrying++;
  }
  return result;
}
