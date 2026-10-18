import { syncAll } from '../../integrations/shopify/sync.js';
import { bindShopifyDispatchSource } from '../../integrations/shopify/dispatch.js';
import { messageOf, runJobPass, scheduledJobs, type JobsStore } from './store.js';

// JOBS-01 runner for scheduled Shopify ingestion (0036). The database owns discovery,
// cadence, leases, backoff and quarantine; this loop claims the due sync job, runs the
// canonical sync for the configured connection and reports how the attempt ended.
// Failures a person must fix (missing settings, the shop refusing the token, identity
// errors in Shopify's data) are `blocked` with their reason; outages are retried.

export type { JobsStore } from './store.js';
export type SourceSync = (context: { orgId: string; sourceId: string }) => Promise<{ customers: number; products: number; orders: number }>;

const NEEDS_A_PERSON = [/^SHOPIFY_/, /shopify \S+ 40[134]\b/, /canonical myshopify\.com domain/, /does not match the configured business\/connection/,
  /binding returned no identity/, /not the configured Shopify connection/, /invalid Shopify .* ID/, /belongs to a different order/,
  /binding mismatch or disabled source/, /malformed Shopify/, /cannot move to a different order/, /duplicate normalized dispatch line/];
export function classifyShopifySync(error: unknown): 'retry' | 'blocked' {
  const message = messageOf(error);
  return NEEDS_A_PERSON.some(p => p.test(message)) ? 'blocked' : 'retry';
}

/** The sync runs only for a deployment that holds a shop domain and token. With those set
 * but wrong or incomplete, the job runs and is blocked with the refusal as its reason. */
export const shopifySyncEnabled = (env: Record<string, string | undefined> = process.env) =>
  Boolean(env.SHOPIFY_SHOP_DOMAIN?.trim() && env.SHOPIFY_ADMIN_API_TOKEN?.trim());

/** Sync the configured connection, after proving it is the job's source. A job for any
 * other connection blocks instead of writing another connection's data under this one. */
export async function syncConfiguredShopifySource(context: { orgId: string; sourceId: string }) {
  const bound = await bindShopifyDispatchSource();
  if (bound !== context.sourceId) throw new Error('sync job source is not the configured Shopify connection');
  return syncAll();
}

export const shopifySyncJobs: JobsStore = scheduledJobs('shopify_sync');

/** One scheduler pass for a business: discover/re-arm, then run the due sync job. One sync
 * per tick is enough; the canonical sync covers everything each run. */
export async function runShopifySyncJobs(orgId: string, options: { limit?: number; store?: JobsStore; sync?: SourceSync } = {}) {
  const sync = options.sync ?? syncConfiguredShopifySource;
  return runJobPass(orgId, options.store ?? shopifySyncJobs, async job => {
    const counts = await sync({ orgId, sourceId: job.source_id });
    return { customers: counts.customers, products: counts.products, orders: counts.orders };
  }, classifyShopifySync, options.limit ?? 1);
}
