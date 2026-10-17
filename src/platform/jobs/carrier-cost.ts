import { syncGoSweetSpotCostFromEnv } from '../../integrations/gosweetspot/client.js';
import { messageOf, runJobPass, scheduledJobs, type JobsStore } from './store.js';

// JOBS-01 runner for carrier cost sync. The database owns discovery, leases, backoff and
// quarantine (0029); this loop only claims due jobs, runs the GoSweetSpot lookup and
// reports how each attempt ended. Failures a person must fix (missing settings, a
// response Atlas cannot read, an uncovered tracking number) are `blocked` and stay visible
// with their reason; transient failures (network, HTTP errors) are retried with backoff.

export type { JobsStore } from './store.js';
export type CostSync = (context: { orgId: string; sourceId: string }, dispatchId: string) => Promise<{ evidenceId: string | null; costMinor: string }>;

const NEEDS_A_PERSON = [/^GOSWEETSPOT_/, /unexpected shipments response shape/, /does not cover every tracking number/,
  /no tracking number/, /no Shopify fulfillment/, /two decimals/, /replay conflicts/, /conflicting duplicate consignment/, /HTTP 40[13]/];
export function classify(error: unknown): 'retry' | 'blocked' {
  const message = messageOf(error);
  return NEEDS_A_PERSON.some(p => p.test(message)) ? 'blocked' : 'retry';
}

/** GoSweetSpot is an optional module: the sync runs only for a deployment that holds an
 * access key. With a key but incomplete settings, the jobs run and are blocked with the
 * missing setting as their reason. */
export const carrierCostSyncEnabled = (env: Record<string, string | undefined> = process.env) => Boolean(env.GOSWEETSPOT_ACCESS_KEY?.trim());

export const databaseJobs: JobsStore = scheduledJobs('carrier_cost_sync');

/** One scheduler pass for a business: discover, then run up to `limit` due jobs. */
export async function runCarrierCostJobs(orgId: string, options: { limit?: number; store?: JobsStore; sync?: CostSync } = {}) {
  const sync = options.sync ?? syncGoSweetSpotCostFromEnv;
  return runJobPass(orgId, options.store ?? databaseJobs, async job => {
    const recorded = await sync({ orgId, sourceId: job.source_id }, job.dispatch_id);
    return { evidence_id: recorded.evidenceId, cost_minor: recorded.costMinor };
  }, classify, options.limit ?? 20);
}
