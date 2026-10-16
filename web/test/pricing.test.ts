import assert from 'node:assert/strict';
import test from 'node:test';
import { PricingConfigSchema, calculatePricing } from '../../src/platform/pricing/versioned';
import {
  firstVersionTemplate, formatInZone, fromBps, fromMinor, issueLabel, nextVersionDraft, previewInput, pricingOutcomeFor, toBps, toMinor, versionStatuses,
  type VersionRow,
} from '../lib/pricing';
import { config } from '../../test/fixtures/pricing/synthetic';

test('typed amounts and percentages convert exactly, or not at all', () => {
  for (const [typed, minor] of [['12.50', '1250'], ['12.5', '1250'], ['0.05', '5'], ['0', '0'], ['1234567.89', '123456789'], [' 7 ', '700']] as const)
    assert.equal(toMinor(typed), minor, typed);
  for (const typed of ['12.345', '-1', '1,50', '1e3', '.5', '', 'abc', '01.00']) assert.equal(toMinor(typed), null, typed);
  assert.equal(fromMinor('1250'), '12.50'); assert.equal(fromMinor('5'), '0.05'); assert.equal(fromMinor('invalid'), '');
  for (const [typed, bps] of [['15', 1500], ['12.5', 1250], ['0.01', 1], ['100', 10000], ['0', 0]] as const) assert.equal(toBps(typed), bps, typed);
  for (const typed of ['100.01', '101', '-1', '1.234', '', 'x']) assert.equal(toBps(typed), null, typed);
  assert.equal(fromBps(1250), '12.5'); assert.equal(fromBps(1205), '12.05'); assert.equal(fromBps(1500), '15'); assert.equal(fromBps(null), '');
});

test('a first version prices nothing until the operator sets every money choice', () => {
  const draft = firstVersionTemplate('biz', [{ id: 'p1', sku: 'A', name: 'Widget' }]);
  const result = PricingConfigSchema.safeParse(draft);
  assert.equal(result.success, false);
  const fields = new Set(result.error!.issues.map(i => String(i.path[0])));
  for (const f of ['name', 'currency', 'taxRateBps', 'freightTaxable', 'effectiveFrom', 'timezone', 'pricingDateBasis', 'tierQuantityBasis', 'terms', 'books'])
    assert.ok(fields.has(f), `${f} must be chosen`);
  assert.equal(draft.books[0]!.entries[0]!.productId, 'p1');
  assert.equal(issueLabel(['books', 0, 'entries', 0, 'unitPrice']), 'Price book 1, product 1 (unitPrice)');
  assert.equal(issueLabel(['taxRateBps']), 'Tax rate');
});

test('the next version starts from the latest one under a new identifier', () => {
  const latest = config();
  const next = nextVersionDraft(latest, 4);
  assert.equal(next.version, 'v5'); assert.equal(next.effectiveFrom, '');
  assert.deepEqual({ ...next, version: latest.version, effectiveFrom: latest.effectiveFrom }, latest);
  assert.match(formatInZone('2026-01-01T00:00:00+13:00', 'Pacific/Auckland'), /1 Jan 2026.*12:00.*am/i);
  assert.notEqual(next.books, latest.books);
});

test('the preview input is a valid calculation of the chosen retailer, invoiced now', () => {
  const c = config();
  const now = new Date('2026-10-16T01:00:00Z');
  const input = previewInput(c, { accountId: 'retailer-a', taxExempt: false, orderAt: '2026-10-01T09:00:00+13:00', dispatchAt: '2026-10-02T09:00:00+13:00',
    destination: '', lines: [{ productId: 'widget', description: 'Widget', ordered: 100, dispatched: 40 }], carrierCost: null, priorParts: 0 }, now);
  const snapshot = calculatePricing(c, input);
  assert.equal(snapshot.lines[0]!.dispatched, 40);
  assert.equal(input.evaluatedAt, now.toISOString()); assert.equal(input.carrier, null);
  const costed = previewInput({ ...c, shipping: { ...c.shipping, rules: [{ ...c.shipping.rules[0]!, mode: { kind: 'actual' } }] } },
    { ...input, accountId: 'retailer-a', taxExempt: false, orderAt: input.orderAt, dispatchAt: input.dispatchAt!, destination: '', lines: [{ productId: 'widget', description: 'Widget', ordered: 100, dispatched: 40 }], carrierCost: '858', priorParts: 0 }, now);
  assert.equal(costed.carrier?.cost, '858'); assert.equal(costed.carrier?.currency, c.currency);
});

test('version status follows activations and effective times', () => {
  const now = new Date('2026-10-16T00:00:00Z');
  const v = (id: string, from: string, until: string | null = null): VersionRow =>
    ({ id, revision: 1, version_key: id, config: { ...config(), version: id, effectiveFrom: from, effectiveUntil: until }, actor: 'a', reason: 'r', created_at: from });
  const versions = [v('old', '2026-01-01T00:00:00Z'), v('now', '2026-10-01T00:00:00Z'), v('later', '2026-11-01T00:00:00Z'), v('draft', '2026-12-01T00:00:00Z')];
  const act = (id: string) => ({ version_id: id, actor: 'a', reason: 'r', created_at: '2026-01-01T00:00:00Z' });
  const s = versionStatuses(versions, [act('old'), act('now'), act('later')], now);
  assert.deepEqual([...s.values()], ['superseded', 'active', 'scheduled', 'saved']);
  assert.equal(versionStatuses([v('ended', '2026-01-01T00:00:00Z', '2026-02-01T00:00:00Z')], [act('ended')], now).get('ended'), 'expired');
});

test('database refusals map to fixed messages', () => {
  assert.equal(pricingOutcomeFor('stale pricing revision'), 'stale');
  assert.equal(pricingOutcomeFor('pricing retry conflicts with stored version'), 'version_taken');
  assert.equal(pricingOutcomeFor('pricing activation must advance effective timeline'), 'timeline');
  assert.equal(pricingOutcomeFor('pricing names products this business does not have: x'), 'unknown_reference');
  assert.equal(pricingOutcomeFor('business actions paused'), 'paused');
  assert.equal(pricingOutcomeFor('tool entitlement missing or revoked'), 'not_allowed');
  assert.equal(pricingOutcomeFor('connection reset'), 'failed');
});
