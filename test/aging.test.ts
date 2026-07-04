// Aging bucket tests — pure math, no IO. Mirrors the SQL `age_bucket` + `overdue_days`
// functions (0020); scripts/sql-ts-parity.ts asserts TS and SQL produce identical results
// against a real database in CI.

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

test('ageBucket — 90 band: 61 days (0020 — no longer mislabelled 90_plus)', () => {
  assert.equal(ageBucket(61), '90');
});

test('ageBucket — 90 band: 90 days', () => {
  assert.equal(ageBucket(90), '90');
});

test('ageBucket — 90_plus: 91 days is genuinely past 90', () => {
  assert.equal(ageBucket(91), '90_plus');
});

test('ageBucket — 90_plus: very overdue', () => {
  assert.equal(ageBucket(365), '90_plus');
});

test('overdueDays — same instant is 0', () => {
  const d = new Date('2026-06-16T12:00:00Z');
  assert.equal(overdueDays(d, d), 0);
});

test('overdueDays — plain calendar delta', () => {
  const anchor = new Date('2026-06-01T00:00:00Z');
  const asOf   = new Date('2026-06-16T00:00:00Z');
  assert.equal(overdueDays(anchor, asOf), 15);
});

test('overdueDays — negative when due in future', () => {
  const anchor = new Date('2026-06-20T00:00:00Z');
  const asOf   = new Date('2026-06-16T00:00:00Z');
  assert.equal(overdueDays(anchor, asOf), -4);
});

test('overdueDays — calendar days, not elapsed 24h windows', () => {
  // 13 days 23h elapsed, but the NZ calendar has moved 14 days (Jun 1 → Jun 15).
  // The old elapsed-floor implementation said 13; day counts are calendar facts.
  const anchor = new Date('2026-06-01T00:00:00Z');   // Jun  1 12:00 NZST
  const asOf   = new Date('2026-06-14T23:00:00Z');   // Jun 15 11:00 NZST
  assert.equal(overdueDays(anchor, asOf), 14);
});

test('overdueDays — DST transition does not lose a day', () => {
  // NZ DST ends 2026-04-05 (03:00 NZDT → 02:00 NZST). Elapsed time is 25.75h (floor: 1),
  // but the NZ calendar has moved Apr 4 → Apr 6 = 2 days.
  const anchor = new Date('2026-04-04T10:30:00Z');   // Apr 4 23:30 NZDT
  const asOf   = new Date('2026-04-05T12:15:00Z');   // Apr 6 00:15 NZST
  assert.equal(overdueDays(anchor, asOf), 2);
});

test('overdueDays — NZ calendar, not UTC calendar', () => {
  // Both instants fall on Jul 1 in NZ; in UTC they straddle midnight Jun 30 / Jul 1.
  const anchor = new Date('2026-06-30T13:00:00Z');   // Jul 1 01:00 NZST
  const asOf   = new Date('2026-07-01T11:00:00Z');   // Jul 1 23:00 NZST
  assert.equal(overdueDays(anchor, asOf), 0);
  assert.equal(overdueDays(anchor, asOf, 'UTC'), 1); // same instants, UTC calendar
});
