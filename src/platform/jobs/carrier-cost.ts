import { supabase } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';
import { syncGoSweetSpotCostFromEnv } from '../../integrations/gosweetspot/client.js';

// JOBS-01 runner for carrier cost sync. The database owns discovery, leases, backoff and
// quarantine (0029); this loop only claims due jobs, runs the GoSweetSpot lookup and
// reports how each attempt ended. Failures a person must fix (missing settings, a
// response Atlas cannot read, an uncovered tracking number) are `blocked` and stay visible
// with their reason; transient failures (network, HTTP errors) are retried with backoff.

type Job = { org_id: string | null; job_key: string | null; source_id: string; dispatch_id: string; lease_token: string | null; attempts: number };
export interface JobsStore {
  discover(orgId: string): Promise<number>;
  claim(orgId: string): Promise<Job | null>;
  finish(orgId: string, job: Job, outcome: 'succeeded' | 'retry' | 'blocked', detail: Record<string, unknown>): Promise<string>;
}
export type CostSync = (context: { orgId: string; sourceId: string }, dispatchId: string) => Promise<{ evidenceId: string | null; costMinor: string }>;

const NEEDS_A_PERSON = [/^GOSWEETSPOT_/, /unexpected shipments response shape/, /does not cover every tracking number/,
  /no tracking number/, /no Shopify fulfillment/, /two decimals/, /replay conflicts/, /HTTP 40[13]/];
// Supabase RPC errors are plain objects with a message, not Error instances.
const messageOf = (error: unknown) =>
  error && typeof error === 'object' && typeof (error as { message?: unknown }).message === 'string' ? (error as { message: string }).message : String(error);
export function classify(error: unknown): 'retry' | 'blocked' {
  const message = messageOf(error);
  return NEEDS_A_PERSON.some(p => p.test(message)) ? 'blocked' : 'retry';
}

/** GoSweetSpot is an optional module: the sync runs only for a deployment that holds an
 * access key. With a key but incomplete settings, the jobs run and are blocked with the
 * missing setting as their reason. */
export const carrierCostSyncEnabled = (env: Record<string, string | undefined> = process.env) => Boolean(env.GOSWEETSPOT_ACCESS_KEY?.trim());

export const databaseJobs: JobsStore = {
  async discover(orgId) {
    const { data, error } = await supabase().rpc('discover_carrier_cost_jobs', { p_org_id: orgId });
    if (error) throw error;
    return data ?? 0;
  },
  async claim(orgId) {
    const { data, error } = await supabase().rpc('claim_scheduled_job', { p_org_id: orgId, p_kind: 'carrier_cost_sync' });
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

/** One scheduler pass for a business: discover, then run up to `limit` due jobs. */
export async function runCarrierCostJobs(orgId: string, options: { limit?: number; store?: JobsStore; sync?: CostSync } = {}) {
  const store = options.store ?? databaseJobs;
  const sync = options.sync ?? syncGoSweetSpotCostFromEnv;
  const result = { discovered: await store.discover(orgId), succeeded: 0, retrying: 0, blocked: 0, quarantined: 0 };
  for (let n = 0; n < (options.limit ?? 20); n++) {
    const job = await store.claim(orgId);
    if (!job) break;
    let outcome: 'succeeded' | 'retry' | 'blocked'; let detail: Record<string, unknown>;
    try {
      const recorded = await sync({ orgId, sourceId: job.source_id }, job.dispatch_id);
      outcome = 'succeeded'; detail = { evidence_id: recorded.evidenceId, cost_minor: recorded.costMinor };
    } catch (e) {
      outcome = classify(e); detail = { error: messageOf(e) };
    }
    const state = await store.finish(orgId, job, outcome, detail);
    if (state === 'succeeded') result.succeeded++; else if (state === 'quarantined') result.quarantined++;
    else if (state === 'blocked') result.blocked++; else result.retrying++;
  }
  return result;
}
