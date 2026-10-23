import assert from 'node:assert/strict';
import test from 'node:test';
import { MEMBER_OUTCOMES, isMemberOutcome, memberOutcomeFor } from '../lib/members';

test('membership refusals map to fixed outcomes, never raw text (0049)', () => {
  assert.equal(memberOutcomeFor('a valid member email is required'), 'invalid');
  assert.equal(memberOutcomeFor('member already exists'), 'exists');
  assert.equal(memberOutcomeFor('add your own membership first'), 'first_self');
  assert.equal(memberOutcomeFor('member email is fixed; add a new member instead'), 'email_fixed');
  assert.equal(memberOutcomeFor('member changed since it was loaded'), 'changed');
  assert.equal(memberOutcomeFor('you cannot disable your own membership'), 'self_disable');
  assert.equal(memberOutcomeFor('member not found'), 'not_found');
  assert.equal(memberOutcomeFor('tool entitlement missing or revoked'), 'not_allowed');
  assert.equal(memberOutcomeFor('managing members cannot itself require an approval; its grant must not require approval'), 'not_allowed');
  assert.equal(memberOutcomeFor('business actions paused'), 'paused');
  assert.equal(memberOutcomeFor('socket hang up'), 'failed');
  for (const key of Object.keys(MEMBER_OUTCOMES)) assert.equal(isMemberOutcome(key), true, key);
  assert.equal(isMemberOutcome('x'), false);
});
