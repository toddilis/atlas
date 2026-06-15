// Routing decision tests — focuses on the env-driven branches that don't require a DB.
// (The DB-backed B2B-account branch is verified end-to-end in the seam-1 test once a live
// Postgres is wired up; the build plan defers live-DB testing.)

import { test } from 'node:test';
import assert from 'node:assert/strict';

async function load() {
  // Reset modules so changing env between tests works deterministically.
  return await import('../src/agents/controller/routing.js');
}

test('venue location id → consignment', async () => {
  process.env.VENUE_LOCATION_IDS = '111,222,333';
  process.env.SHOPIFY_MAIN_LOCATION_ID = '999';
  const { decideRoute } = await load();
  const r = await decideRoute({
    shopifyFulfillmentId: 'f1',
    shopifyOrderId: 'o1',
    locationId: '222',
  });
  assert.equal(r.route, 'consignment');
  assert.equal(r.accountId, null);
  assert.match(r.reason, /venue/);
});

test('unrecognised location id → ignored', async () => {
  process.env.VENUE_LOCATION_IDS = '111,222';
  process.env.SHOPIFY_MAIN_LOCATION_ID = '999';
  const { decideRoute } = await load();
  const r = await decideRoute({
    shopifyFulfillmentId: 'f1',
    shopifyOrderId: 'o1',
    locationId: '888',
  });
  assert.equal(r.route, 'ignored');
  assert.equal(r.accountId, null);
  assert.match(r.reason, /matches neither/);
});

test('missing location id → ignored', async () => {
  process.env.VENUE_LOCATION_IDS = '111,222';
  process.env.SHOPIFY_MAIN_LOCATION_ID = '999';
  const { decideRoute } = await load();
  const r = await decideRoute({
    shopifyFulfillmentId: 'f1',
    shopifyOrderId: 'o1',
    locationId: null,
  });
  assert.equal(r.route, 'ignored');
  assert.match(r.reason, /no location id/);
});
