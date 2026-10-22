import assert from 'node:assert/strict';
import test from 'node:test';
import { PROFILE_OUTCOMES, isProfileOutcome, profileOutcomeFor } from '../lib/profile';

test('database refusals map to fixed outcomes, never raw text', () => {
  assert.equal(profileOutcomeFor('profile changed since it was loaded'), 'stale');
  assert.equal(profileOutcomeFor('profile field too long'), 'invalid');
  assert.equal(profileOutcomeFor('tool entitlement missing or revoked'), 'not_allowed');
  assert.equal(profileOutcomeFor('business actions paused'), 'paused');
  assert.equal(profileOutcomeFor('socket hang up'), 'failed');
  for (const key of Object.keys(PROFILE_OUTCOMES)) assert.equal(isProfileOutcome(key), true, key);
  assert.equal(isProfileOutcome('x'), false);
});
