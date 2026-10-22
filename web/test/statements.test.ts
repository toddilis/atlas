import assert from 'node:assert/strict';
import test from 'node:test';
import { STATEMENT_OUTCOMES, isStatementOutcome, statementOutcomeFor } from '../lib/statements';

test('database refusals map to fixed outcomes, never raw text', () => {
  assert.equal(statementOutcomeFor('statement as-of must not be in the future'), 'invalid');
  assert.equal(statementOutcomeFor('generate_statement_atomic: invalid period'), 'invalid');
  assert.equal(statementOutcomeFor('generate_statement_atomic: account x not found in org y'), 'not_found');
  assert.equal(statementOutcomeFor('tool entitlement missing or revoked'), 'not_allowed');
  assert.equal(statementOutcomeFor('business actions paused'), 'paused');
  assert.equal(statementOutcomeFor('unknown statement timezone'), 'failed');
  assert.equal(statementOutcomeFor('socket hang up'), 'failed');
  for (const key of Object.keys(STATEMENT_OUTCOMES)) assert.equal(isStatementOutcome(key), true, key);
  assert.equal(isStatementOutcome('x'), false);
});
