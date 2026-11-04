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

// CONFIG-01d: the main-location decision, from the order and its customer's decision alone.
test('main location: a linked retailer is invoiced only while Shopify shows the order unpaid', async () => {
  const { routeMainLocation } = await load();
  const draft = (financialStatus: string | null) => ({ shopifyCustomerId: 'c1', financialStatus, sourceName: 'shopify_draft_order' });
  const linked = { accountId: 'acct-1', doNotInvoice: false };
  assert.deepEqual(routeMainLocation(draft('pending'), linked),
    { route: 'wholesale', reason: 'main location + linked retailer + unpaid in Shopify', accountId: 'acct-1' });
  // Paid means paid: never invoiced, and neither is anything not plainly unpaid.
  for (const status of ['paid', 'partially_paid', 'authorized', 'refunded', 'voided', null]) {
    const r = routeMainLocation(draft(status), linked);
    assert.equal(r.route, 'ignored', String(status));
    assert.equal(r.accountId, null);
    assert.match(r.reason, new RegExp(`${status ?? 'payment status unknown'} in Shopify: not invoiced`));
  }
  // A linked retailer's unpaid web order is invoiced too: the link decides, not the channel.
  assert.equal(routeMainLocation({ ...draft('pending'), sourceName: 'web' }, linked).route, 'wholesale');
});

test('main location: an undecided customer\'s unpaid draft order waits for a person; a rep is never invoiced', async () => {
  const { routeMainLocation } = await load();
  const order = { shopifyCustomerId: 'c2', financialStatus: 'pending', sourceName: 'shopify_draft_order' };
  const held = routeMainLocation(order, { accountId: null, doNotInvoice: false });
  assert.equal(held.route, 'held');
  assert.match(held.reason, /not yet linked to a retailer: decide on the Customers page/);
  // A customer Atlas has not synced yet is undecided too.
  assert.equal(routeMainLocation(order, null).route, 'held');
  assert.deepEqual(routeMainLocation(order, { accountId: null, doNotInvoice: true }),
    { route: 'ignored', reason: 'main location, customer marked not invoiced', accountId: null });
  // A draft order without a customer cannot be decided per customer: said plainly.
  assert.match(routeMainLocation({ ...order, shopifyCustomerId: null }, null).reason, /without a Shopify customer: invoice it by hand/);
  // Paid draft orders and retail orders are not held.
  assert.equal(routeMainLocation({ ...order, financialStatus: 'paid' }, null).route, 'ignored');
  const retail = routeMainLocation({ ...order, sourceName: 'web' }, null);
  assert.equal(retail.route, 'ignored');
  assert.match(retail.reason, /retail order/);
});
