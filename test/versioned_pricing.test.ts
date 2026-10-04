import test from 'node:test';
import assert from 'node:assert/strict';
import { calculatePricing, previewPricing, PricingConfigSchema } from '../src/platform/pricing/versioned.js';
import { config, input } from './fixtures/pricing/synthetic.js';

test('40/60 previews retain ordered-volume tier and allocate exactly configured freight', () => {
  const a = calculatePricing(config(), input());
  const bInput = input(); bInput.dispatchKey = 'dispatch-b'; bInput.lines[0]!.dispatched = 60;
  const b = calculatePricing(config(), bInput);
  assert.equal(a.subtotal, '32000'); assert.equal(b.subtotal, '48000');
  assert.equal(a.freight.amount, '400'); assert.equal(b.freight.amount, '600');
  assert.equal(a.total, '37260'); assert.equal(b.total, '55890');
  assert.equal(a.terms.dueDate, '2026-11-20'); assert.match(a.lines[0]!.explanation, /tier volume-100/);
});
test('retailer discount and negotiated price honor explicit precedence and combination', () => {
  const c = config(); c.tiers = []; c.shipping.enabled = false; c.shipping.rules = [];
  const i = input(); i.freightSchedule = null;
  assert.equal(calculatePricing(c, i).lines[0]!.unitPrice, '1000');
  i.accountId = 'retailer-b'; assert.equal(calculatePricing(c, i).lines[0]!.unitPrice, '900');
  c.negotiated.push({ id: 'deal', accountId: 'retailer-b', productId: 'widget', unitPrice: '700' });
  assert.equal(calculatePricing(c, i).lines[0]!.unitPrice, '700');
  c.discountOnSpecialPrice = true; assert.equal(calculatePricing(c, i).lines[0]!.unitPrice, '630');
});
test('effective boundaries and old snapshot survive mutated configuration', () => {
  const c = config(); const i = input(); const snapshot = calculatePricing(c, i); const saved = JSON.stringify(snapshot);
  c.tiers[0]!.unitPrice = '900'; c.version = 'v2'; calculatePricing(c, i);
  assert.equal(JSON.stringify(snapshot), saved);
  c.effectiveUntil = '2026-10-01T09:00:00+13:00'; assert.throws(() => calculatePricing(c, i), /not effective/);
  c.effectiveUntil = null; c.effectiveFrom = i.orderAt; assert.doesNotThrow(() => calculatePricing(c, i));
  c.effectiveFrom = '2026-10-01T09:00:01+13:00'; assert.throws(() => calculatePricing(c, i), /not effective/);
});
test('same offerings support non-stock service preview without dispatch, carrier or inventory', () => {
  const c = config(); c.businessId = 'services'; c.name = 'Synthetic design services'; c.shipping = { enabled: false, rules: [] }; c.tiers = []; c.taxRateBps = 0;
  const i = input(); i.businessId = 'services'; i.dispatchKey = null; i.dispatchAt = null; i.freightSchedule = null;
  i.terms = { kind: 'explicit', dueDate: '2026-10-31', actor: 'synthetic-operator', reason: 'Synthetic milestone terms' };
  const s = calculatePricing(c, i); assert.equal(s.freight.basis, 'disabled'); assert.equal(s.total, '40000');
  assert.throws(() => calculatePricing(config(), i), /wrong business/);
});
test('all shipping modes preserve unknown cost separately from an explicit charge', () => {
  const c = config(); const i = input(); c.shipping.rules[0]!.chargingBasis = 'per_dispatch'; i.freightSchedule = null;
  assert.equal(calculatePricing(c, i).freight.carrier, null);
  c.shipping.rules[0]!.mode = { kind: 'actual' }; assert.equal(previewPricing(c,i).status, 'blocked');
  i.carrier = { businessId: i.businessId, connectionId: 'carrier', shipmentKey: i.dispatchKey!, quoteId: 'quote', observedAt: '2026-10-02T09:00:00+13:00', expiresAt: '2026-10-03T09:00:00+13:00', currency: 'NZD', taxBasis: 'exclusive', cost: '333' };
  assert.equal(calculatePricing(c,i).freight.amount, '333');
  c.shipping.rules[0]!.mode = { kind: 'adjusted', fixed: '100', markupBps: 1000 }; assert.equal(calculatePricing(c,i).freight.amount, '466');
  c.shipping.rules[0]!.mode = { kind: 'free' }; assert.equal(calculatePricing(c,i).freight.amount, '0');
  c.shipping.rules[0]!.mode = { kind: 'manual' }; assert.throws(() => calculatePricing(c,i), /override required/);
  i.freightOverride = { amount: '0', actor: 'operator', reason: 'Courtesy' }; assert.equal(calculatePricing(c,i).freight.amount, '0');
});
test('carrier scope, expiry and currency fail closed; no FX or zero fallback', () => {
  const c = config(); const i = input(); c.shipping.rules[0]!.chargingBasis = 'per_dispatch'; c.shipping.rules[0]!.mode = { kind: 'actual' }; i.freightSchedule = null;
  i.carrier = { businessId: i.businessId, connectionId: 'carrier', shipmentKey: i.dispatchKey!, quoteId: 'quote', observedAt: i.dispatchAt!, expiresAt: i.evaluatedAt, currency: 'NZD', taxBasis: 'exclusive', cost: '500' };
  assert.throws(() => calculatePricing(c,i), /expired/);
  i.carrier.expiresAt = '2026-11-01T00:00:00Z'; i.carrier.currency = 'USD'; assert.throws(() => calculatePricing(c,i), /binding/);
  i.carrier.currency = 'NZD'; i.carrier.businessId = 'other'; assert.throws(() => calculatePricing(c,i), /binding/);
});
test('threshold below, at and above uses declared discounted taxed dispatch basis', () => {
  const c = config(); const i = input(); c.shipping.rules[0]!.chargingBasis = 'per_dispatch'; i.freightSchedule = null;
  c.shipping.rules[0]!.freeThreshold = { amount: '36801', valueBasis: 'dispatch', afterDiscount: true, includesTax: true };
  assert.equal(calculatePricing(c,i).freight.amount, '1000');
  c.shipping.rules[0]!.freeThreshold!.amount = '36800'; assert.equal(calculatePricing(c,i).freight.amount, '0');
  c.shipping.rules[0]!.freeThreshold!.amount = '36799'; assert.equal(calculatePricing(c,i).freight.amount, '0');
});
test('ambiguous rules, missing products and invalid freight schedule are explicit exceptions', () => {
  const c = config(); const i = input(); c.tiers.push({ ...c.tiers[0]!, id: 'conflict' }); assert.throws(() => calculatePricing(c,i), /conflicting/);
  c.tiers.pop(); i.lines[0]!.productId = 'unknown'; assert.throws(() => calculatePricing(c,i), /missing product/);
  i.lines[0]!.productId = 'widget'; i.freightSchedule!.allocations[1]!.amount = '601'; assert.throws(() => calculatePricing(c,i), /allocation/);
  c.books[0]!.entries.push({ productId: 'widget', unitPrice: '5' }); assert.equal(PricingConfigSchema.safeParse(c).success, false);
});
test('unsafe numeric money rejected and bigint computations are exact', () => {
  const c = config(); const i = input(); c.tiers = []; c.shipping = { enabled: false, rules: [] }; i.freightSchedule = null;
  c.books[0]!.entries[0]!.unitPrice = '9007199254740993'; i.lines[0]!.ordered = 1; i.lines[0]!.dispatched = 1;
  const s = calculatePricing(c,i); assert.equal(s.tax.amount, '1351079888211148'); assert.equal(s.total, '10358279142952141');
  assert.throws(() => calculatePricing({ ...c, taxRateBps: 1.5 },i));
});

