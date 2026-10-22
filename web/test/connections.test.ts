import assert from 'node:assert/strict';
import test from 'node:test';
import { CONNECTION_OUTCOMES, connectionOutcomeFor, isConnectionOutcome } from '../lib/connections';

test('database refusals map to fixed outcomes, never raw text', () => {
  assert.equal(connectionOutcomeFor('a canonical Shopify shop domain is required'), 'bad_domain');
  assert.equal(connectionOutcomeFor('this business already has its Shopify connection'), 'already_connected');
  assert.equal(connectionOutcomeFor('Shopify connection binding mismatch or disabled source'), 'already_connected');
  assert.equal(connectionOutcomeFor("the connection's shop domain is fixed"), 'key_fixed');
  assert.equal(connectionOutcomeFor('sync cadence minutes out of range'), 'cadence');
  assert.equal(connectionOutcomeFor('connection changed since it was loaded'), 'stale');
  assert.equal(connectionOutcomeFor('business actions paused'), 'paused');
  assert.equal(connectionOutcomeFor('tool entitlement missing or revoked'), 'not_allowed');
  assert.equal(connectionOutcomeFor('connection not found'), 'not_found');
  assert.equal(connectionOutcomeFor('socket hang up'), 'failed');
  for (const key of Object.keys(CONNECTION_OUTCOMES)) assert.equal(isConnectionOutcome(key), true, key);
  assert.equal(isConnectionOutcome('x'), false);
});
