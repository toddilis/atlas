import assert from 'node:assert/strict';
import test from 'node:test';
import { CATALOG_OUTCOMES, catalogOutcomeFor, isCatalogOutcome, isSynced } from '../lib/catalog';

test('database refusals map to fixed outcomes, never raw text', () => {
  assert.equal(catalogOutcomeFor('sku already exists'), 'duplicate_sku');
  assert.equal(catalogOutcomeFor('retailer name already exists'), 'duplicate_name');
  assert.equal(catalogOutcomeFor('product changed since it was loaded'), 'stale');
  assert.equal(catalogOutcomeFor('retailer changed since it was loaded'), 'stale');
  assert.equal(catalogOutcomeFor('synced product sku is fixed'), 'synced_sku');
  assert.equal(catalogOutcomeFor('retailer currency is fixed once it has invoices'), 'currency_fixed');
  assert.equal(catalogOutcomeFor('catalogue fields required'), 'invalid');
  assert.equal(catalogOutcomeFor('catalogue field too long'), 'invalid');
  assert.equal(catalogOutcomeFor('retailer currency must be a 3-letter code'), 'invalid');
  assert.equal(catalogOutcomeFor('retailer payment terms days out of range'), 'invalid');
  assert.equal(catalogOutcomeFor('unknown retailer status'), 'invalid');
  assert.equal(catalogOutcomeFor('retailer billing email invalid'), 'invalid');
  assert.equal(catalogOutcomeFor('tool entitlement missing or revoked'), 'not_allowed');
  assert.equal(catalogOutcomeFor('business actions paused'), 'paused');
  assert.equal(catalogOutcomeFor('product not found'), 'not_found');
  assert.equal(catalogOutcomeFor('retailer not found'), 'not_found');
  assert.equal(catalogOutcomeFor('connection reset by peer'), 'failed');
  for (const key of Object.keys(CATALOG_OUTCOMES)) assert.equal(isCatalogOutcome(key), true, key);
  assert.equal(isCatalogOutcome('x'), false);
});

test('a product is synced when either Shopify id is present', () => {
  assert.equal(isSynced({ shopify_product_id: 'p1', shopify_variant_id: null }), true);
  assert.equal(isSynced({ shopify_product_id: null, shopify_variant_id: 'v1' }), true);
  assert.equal(isSynced({ shopify_product_id: null, shopify_variant_id: null }), false);
});
