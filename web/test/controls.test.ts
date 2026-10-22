import assert from 'node:assert/strict';
import test from 'node:test';
import { CONTROLS_OUTCOMES, controlsOutcomeFor, isControlsOutcome } from '../lib/controls';

test('database refusals map to fixed outcomes, never raw text', () => {
  assert.equal(controlsOutcomeFor('tool entitlement missing or revoked'), 'not_allowed');
  assert.equal(controlsOutcomeFor('the emergency stop cannot wait for an approval; its grant must not require approval'), 'not_allowed');
  assert.equal(controlsOutcomeFor('agent disabled'), 'not_allowed');
  assert.equal(controlsOutcomeFor('pause reason required'), 'reason');
  assert.equal(controlsOutcomeFor('connection reset by peer'), 'failed');
  for (const key of Object.keys(CONTROLS_OUTCOMES)) assert.equal(isControlsOutcome(key), true, key);
  assert.equal(isControlsOutcome('x'), false);
});
