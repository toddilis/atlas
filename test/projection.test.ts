// Pure-logic tests for the projection-durability layer (PR-J): the replay eligibility rule
// that decides which event_projections rows the automatic loop re-dispatches. The DB
// mechanics (0017 trigger, state writes, seq-ordered drain) are exercised against a real
// Postgres by scripts/verify-migrations.sh and, from PR-M, in CI.

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  replayEligible,
  MAX_PROJECTION_ATTEMPTS,
  PENDING_GRACE_MS,
} from '../src/platform/events/projector.js';

const NOW = new Date('2026-07-02T10:00:00Z');
const iso = (msAgo: number) => new Date(NOW.getTime() - msAgo).toISOString();

test('replayEligible — failed rows are eligible immediately', () => {
  assert.equal(replayEligible({ state: 'failed', attempts: 1, updatedAt: iso(0) }, NOW), true);
});

test('replayEligible — failed rows at the attempt cap are not eligible (dead-bound)', () => {
  assert.equal(
    replayEligible({ state: 'failed', attempts: MAX_PROJECTION_ATTEMPTS, updatedAt: iso(0) }, NOW),
    false,
  );
});

test('replayEligible — fresh pending rows are left alone (dispatch may be in flight)', () => {
  assert.equal(
    replayEligible({ state: 'pending', attempts: 0, updatedAt: iso(PENDING_GRACE_MS - 1) }, NOW),
    false,
  );
});

test('replayEligible — stale pending rows (crashed before dispatch) become eligible', () => {
  assert.equal(
    replayEligible({ state: 'pending', attempts: 0, updatedAt: iso(PENDING_GRACE_MS) }, NOW),
    true,
  );
});

test('replayEligible — projected rows are never replayed', () => {
  assert.equal(
    replayEligible({ state: 'projected', attempts: 1, updatedAt: iso(86_400_000) }, NOW),
    false,
  );
});

test('replayEligible — dead rows are excluded from the automatic loop', () => {
  assert.equal(
    replayEligible(
      { state: 'dead', attempts: MAX_PROJECTION_ATTEMPTS, updatedAt: iso(86_400_000) },
      NOW,
    ),
    false,
  );
});

test('replayEligible — custom grace and cap are honoured', () => {
  const row = { state: 'pending', attempts: 2, updatedAt: iso(5_000) };
  assert.equal(replayEligible(row, NOW, 10_000, 3), false);   // within grace
  assert.equal(replayEligible(row, NOW, 5_000, 3), true);     // at grace boundary
  assert.equal(replayEligible(row, NOW, 5_000, 2), false);    // at cap
});
