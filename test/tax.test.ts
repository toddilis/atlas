// Tax helper tests — pure math, no IO. The TS function mirrors the SQL
// `compute_gst_cents` (migration 0014); these cases should produce identical results
// when the same inputs are passed to the SQL function in live verification.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeGstCents } from '../src/platform/pricing/tax.js';

test('computeGstCents — standard NZ rate, round-trip case', () => {
  // $100 subtotal → $15 GST → $115 total. No rounding edge.
  assert.equal(computeGstCents(10000, { rateBps: 1500, exempt: false }), 1500);
});

test('computeGstCents — floor behaviour on rounding boundary', () => {
  // $100.01 subtotal × 15% = 1500.15 cents → floor = 1500.
  assert.equal(computeGstCents(10001, { rateBps: 1500, exempt: false }), 1500);
});

test('computeGstCents — exempt account zeros tax', () => {
  assert.equal(computeGstCents(10000, { rateBps: 1500, exempt: true }), 0);
});

test('computeGstCents — zero rate disables tax', () => {
  assert.equal(computeGstCents(10000, { rateBps: 0, exempt: false }), 0);
});

test('computeGstCents — zero subtotal yields zero tax', () => {
  assert.equal(computeGstCents(0, { rateBps: 1500, exempt: false }), 0);
});

test('computeGstCents — large invoice still floors cleanly', () => {
  // $9,999.99 × 15% = 149,999.85 cents → floor = 149,999.
  assert.equal(computeGstCents(999999, { rateBps: 1500, exempt: false }), 149999);
});

test('computeGstCents — rejects negative subtotal', () => {
  assert.throws(
    () => computeGstCents(-1, { rateBps: 1500, exempt: false }),
    /non-negative/,
  );
});

test('computeGstCents — rejects negative rate', () => {
  assert.throws(
    () => computeGstCents(10000, { rateBps: -1, exempt: false }),
    /non-negative/,
  );
});
