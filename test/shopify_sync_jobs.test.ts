import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyShopifySync, runShopifySyncJobs, shopifySyncEnabled } from '../src/platform/jobs/shopify-sync.js';
import type { JobsStore } from '../src/platform/jobs/store.js';

const ORG = '70000000-0000-4000-8000-000000000001';
const job = (n: number) => ({ org_id: ORG, job_key: `shopify-sync:src-${n}`, source_id: `src-${n}`, dispatch_id: null, lease_token: `lease-${n}`, attempts: 1 });
function fakeStore(count: number) {
  const queue = Array.from({ length: count }, (_, i) => job(i + 1));
  const finished: Array<{ key: string; outcome: string; detail: Record<string, unknown> }> = [];
  const store: JobsStore = {
    discover: async () => count,
    claim: async () => queue.shift() ?? null,
    finish: async (_org, j, outcome, detail) => { finished.push({ key: j.job_key!, outcome, detail }); return outcome === 'retry' ? 'failed' : outcome; },
  };
  return { store, finished };
}

test('the sync job records what it pulled; what stops one is its recorded reason', async () => {
  const { store, finished } = fakeStore(3);
  const contexts: unknown[] = [];
  const result = await runShopifySyncJobs(ORG, { limit: 3, store, sync: async (context) => {
    contexts.push(context);
    if (context.sourceId === 'src-2') throw new Error('SHOPIFY_ADMIN_API_TOKEN must be set');
    if (context.sourceId === 'src-3') throw { message: 'shopify orders.json 500: upstream', code: 'X' };
    return { customers: 2, products: 5, orders: 7 };
  } });
  assert.deepEqual(result, { discovered: 3, succeeded: 1, retrying: 1, blocked: 1, quarantined: 0, unfinished: 0 });
  assert.deepEqual(finished.map(f => f.outcome), ['succeeded', 'blocked', 'retry']);
  assert.deepEqual(finished[0]!.detail, { customers: 2, products: 5, orders: 7 });
  assert.deepEqual(finished[1]!.detail, { error: 'SHOPIFY_ADMIN_API_TOKEN must be set' });
  // The business comes from the worker's binding and the source from the job, never elsewhere.
  assert.deepEqual(contexts[0], { orgId: ORG, sourceId: 'src-1' });
});

test('one sync per pass by default', async () => {
  const { store, finished } = fakeStore(2);
  const result = await runShopifySyncJobs(ORG, { store, sync: async () => ({ customers: 0, products: 0, orders: 0 }) });
  assert.equal(result.succeeded, 1);
  assert.equal(finished.length, 1);
});

test('outages are retried; wrong settings, refusals and data Atlas rejects wait for a person', () => {
  for (const m of ['fetch failed', 'shopify orders.json 500: upstream', 'shopify orders.json 429: throttled',
    'could not serialize access due to concurrent update', 'canceling statement due to statement timeout'])
    assert.equal(classifyShopifySync(new Error(m)), 'retry', m);
  for (const m of ['SHOPIFY_SHOP_DOMAIN must be set', 'SHOPIFY_SHOP_DOMAIN must be the canonical myshopify.com domain',
    'shopify orders.json 401: unauthorized', 'shopify customers.json 403: forbidden', 'shopify orders.json 404: not found',
    'sync job source is not the configured Shopify connection', 'Shopify sync context does not match the configured business/connection',
    'Shopify source binding returned no identity', 'Shopify connection binding mismatch or disabled source',
    'invalid Shopify order ID; numeric IDs must be safe integers or decimal strings',
    'embedded Shopify fulfillment belongs to a different order', 'malformed Shopify fulfillment identity',
    'dispatch cannot move to a different order', 'duplicate normalized dispatch line identity'])
    assert.equal(classifyShopifySync(new Error(m)), 'blocked', m);
});

test('the sync pass runs only with a shop and token configured', () => {
  assert.equal(shopifySyncEnabled({}), false);
  assert.equal(shopifySyncEnabled({ SHOPIFY_SHOP_DOMAIN: 'x.myshopify.com' }), false);
  assert.equal(shopifySyncEnabled({ SHOPIFY_SHOP_DOMAIN: ' ', SHOPIFY_ADMIN_API_TOKEN: 't' }), false);
  assert.equal(shopifySyncEnabled({ SHOPIFY_SHOP_DOMAIN: 'x.myshopify.com', SHOPIFY_ADMIN_API_TOKEN: 't' }), true);
});
