// Aging bucket tests — pure math, no IO. Mirrors the SQL `age_bucket` function in
// migration 0015 so live verification can assert TS and SQL produce identical labels.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ageBucket, overdueDays } from '../src/platform/pricing/aging.js';

test('ageBucket — current: 0 days', () => {
  assert.equal(ageBucket(0), 'current');
});

test('ageBucket — current: due in the future is current', () => {
  assert.equal(ageBucket(-5), 'current');
});

test('ageBucket — 30 band: 1 day overdue', () => {
  assert.equal(ageBucket(1), '30');
});

test('ageBucket — 30 band: 30 days overdue is still 30', () => {
  assert.equal(ageBucket(30), '30');
});

test('ageBucket — 60 band: 31 days bumps to 60', () => {
  assert.equal(ageBucket(31), '60');
});

test('ageBucket — 60 band: 60 days', () => {
  assert.equal(ageBucket(60), '60');
});

test('ageBucket — 90_plus: 61 days', () => {
  assert.equal(ageBucket(61), '90_plus');
});

test('ageBucket — 90_plus: very overdue', () => {
  assert.equal(ageBucket(365), '90_plus');
});

test('overdueDays — same day is 0', () => {
  const d = new Date('2026-06-16T12:00:00Z');
  assert.equal(overdueDays(d, d), 0);
});

test('overdueDays — calendar day delta', () => {
  const anchor = new Date('2026-06-01T00:00:00Z');
  const asOf   = new Date('2026-06-16T00:00:00Z');
  assert.equal(overdueDays(anchor, asOf), 15);
});

test('overdueDays — negative when due in future', () => {
  const anchor = new Date('2026-06-20T00:00:00Z');
  const asOf   = new Date('2026-06-16T00:00:00Z');
  assert.equal(overdueDays(anchor, asOf), -4);
});

test('overdueDays — partial day floors down', () => {
  // 14 days + 23 hours apart → 14 full days
  const anchor = new Date('2026-06-01T00:00:00Z');
  const asOf   = new Date('2026-06-14T23:00:00Z');
  assert.equal(overdueDays(anchor, asOf), 13);
});
