import test from 'node:test';
import assert from 'node:assert/strict';
import { consignmentEvidence, costMinor } from '../src/integrations/gosweetspot/consignment.js';

const connection = { siteId: '12345', currency: 'NZD', validityDays: 30 };
const observed = new Date('2026-10-02T09:30:00+13:00');
// Shape of a documented api/shipments response; extra fields are evidence, not inputs.
const shipment = (...consignments: Array<{ ConsignmentId: number | string; Connote: string; Cost: number }>) =>
  ({ CarrierName: 'Synthetic Couriers', Consignments: consignments.map(c => ({ ...c, TrackingUrl: `https://track.example/${c.Connote}` })) });

test('a matched consignment becomes exact carrier cost evidence for the dispatch', () => {
  const e = consignmentEvidence(shipment({ ConsignmentId: 901, Connote: 'SYN000123', Cost: 8.58 }, { ConsignmentId: 902, Connote: 'OTHER', Cost: 99 }), ['syn000123'], connection, observed);
  assert.equal(e.costMinor, 858n); assert.equal(e.carrierConnection, 'gosweetspot:12345'); assert.equal(e.quoteKey, 'consignment:901');
  assert.equal(e.currency, 'NZD'); assert.equal(e.observedAt, '2026-10-01T20:30:00.000Z'); assert.equal(e.expiresAt, '2026-10-31T20:30:00.000Z');
  assert.equal(e.evidence.consignments.length, 1);
});
test('a dispatch shipped as several consignments records their summed cost once', () => {
  const e = consignmentEvidence(shipment({ ConsignmentId: 'B2', Connote: 'BOX2', Cost: 0.1 }, { ConsignmentId: 'A1', Connote: 'BOX1', Cost: 0.2 }), ['BOX1', 'BOX2'], connection, observed);
  assert.equal(e.costMinor, 30n); assert.equal(e.quoteKey, 'consignment:A1+B2');
});
test('partial, unmatched, duplicate, untracked or inexact responses record nothing', () => {
  assert.throws(() => consignmentEvidence(shipment({ ConsignmentId: 1, Connote: 'BOX1', Cost: 5 }), ['BOX1', 'BOX2'], connection, observed), /every tracking number/);
  assert.throws(() => consignmentEvidence(shipment({ ConsignmentId: 1, Connote: 'ELSE', Cost: 5 }), ['BOX1'], connection, observed), /every tracking number/);
  assert.throws(() => consignmentEvidence(shipment({ ConsignmentId: 1, Connote: 'BOX1', Cost: 5 }, { ConsignmentId: 1, Connote: 'box1', Cost: 5 }), ['BOX1'], connection, observed), /duplicate/);
  assert.throws(() => consignmentEvidence(shipment({ ConsignmentId: 1, Connote: 'BOX1', Cost: 5 }), [], connection, observed), /no tracking number/);
  assert.throws(() => consignmentEvidence(shipment({ ConsignmentId: 1, Connote: 'BOX1', Cost: 5.555 }), ['BOX1'], connection, observed), /two decimals/);
  assert.throws(() => consignmentEvidence(shipment({ ConsignmentId: 1, Connote: 'BOX1', Cost: -1 }), ['BOX1'], connection, observed));
  assert.throws(() => consignmentEvidence({ Consignments: [] }, ['BOX1'], connection, observed));
  assert.throws(() => consignmentEvidence(shipment({ ConsignmentId: 1, Connote: 'BOX1', Cost: 5 }), ['BOX1'], { ...connection, currency: 'nzd' }, observed));
  assert.throws(() => consignmentEvidence(shipment({ ConsignmentId: 1, Connote: 'BOX1', Cost: 5 }), ['BOX1'], connection, new Date(Date.now() + 60_000)), /future/);
});
test('dollar amounts convert to cents exactly', () => {
  for (const [d, c] of [[0, 0n], [0.01, 1n], [8.58, 858n], [10.1, 1010n], [1234567.89, 123456789n]] as const) assert.equal(costMinor(d), c);
});
import { fetchShipmentsByConnote, GOSWEETSPOT_API } from '../src/integrations/gosweetspot/client.js';

const fake = (status: number, body: unknown) => {
  const calls: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetcher = async (url: string, init: { headers: Record<string, string> }) => { calls.push({ url, ...init }); return { ok: status < 300, status, json: async () => body }; };
  return { calls, fetcher };
};
const credentials = { accessKey: 'synthetic-key', siteId: '12345' };

test('looks up booked shipments by connote with the documented headers and maps their cost', async () => {
  const { calls, fetcher } = fake(200, [{ Consignments: [{ ConsignmentId: 7, Connote: 'BOX1', Cost: 12.34 }] }, { Consignments: [{ ConsignmentId: 8, Connote: 'BOX2', Cost: 1 }] }]);
  const response = await fetchShipmentsByConnote(credentials, ['BOX1', 'BOX2'], fetcher);
  assert.equal(calls[0]!.url, `${GOSWEETSPOT_API}/shipments?shipments=BOX1%2CBOX2&pagesize=250`);
  assert.deepEqual(calls[0]!.headers, { access_key: 'synthetic-key', site_id: '12345', accept: 'application/json' });
  const e = consignmentEvidence(response, ['BOX1', 'BOX2'], { ...connection, siteId: credentials.siteId }, observed);
  assert.equal(e.costMinor, 1334n); assert.equal(e.quoteKey, 'consignment:7+8');
});
test('an HTTP error or an unexpected response shape records no cost', async () => {
  await assert.rejects(fetchShipmentsByConnote(credentials, ['BOX1'], fake(401, {}).fetcher), /HTTP 401/);
  await assert.rejects(fetchShipmentsByConnote(credentials, ['BOX1'], fake(200, [{ ConsignmentNumber: 'BOX1', TotalCost: 12.34 }]).fetcher), /unexpected shipments response shape/);
  await assert.rejects(fetchShipmentsByConnote({ accessKey: '', siteId: '1' }, ['BOX1'], fake(200, []).fetcher), /access key/);
  await assert.rejects(fetchShipmentsByConnote(credentials, [], fake(200, []).fetcher), /no consignment numbers/);
});
