import assert from 'node:assert/strict';
import test from 'node:test';
import { STATEMENT_OUTCOMES, isStatementOutcome, statementOutcomeFor } from '../lib/statements';

test('database refusals map to fixed outcomes, never raw text', () => {
  assert.equal(statementOutcomeFor('generate', 'statement as-of must not be in the future'), 'invalid');
  assert.equal(statementOutcomeFor('generate', 'generate_statement_atomic: invalid period'), 'invalid');
  assert.equal(statementOutcomeFor('generate', 'generate_statement_atomic: account x not found in org y'), 'not_found');
  assert.equal(statementOutcomeFor('generate', 'tool entitlement missing or revoked'), 'not_allowed');
  assert.equal(statementOutcomeFor('generate', 'business actions paused'), 'paused');
  assert.equal(statementOutcomeFor('generate', 'unknown statement timezone'), 'failed');
  assert.equal(statementOutcomeFor('generate', 'socket hang up'), 'failed');
  for (const key of Object.keys(STATEMENT_OUTCOMES)) assert.equal(isStatementOutcome(key), true, key);
  assert.equal(isStatementOutcome('x'), false);
});

test('lifecycle refusals map per action (0047)', () => {
  assert.equal(statementOutcomeFor('send', 'statement already voided'), 'already_voided');
  assert.equal(statementOutcomeFor('void', 'statement already voided'), 'already_voided');
  assert.equal(statementOutcomeFor('void', 'void reason required'), 'void_invalid');
  assert.equal(statementOutcomeFor('void', 'void reason too long'), 'void_invalid');
  for (const action of ['send', 'void'] as const) {
    assert.equal(statementOutcomeFor(action, 'statement not found'), 'not_found');
    assert.equal(statementOutcomeFor(action, 'business actions paused'), 'paused');
    assert.equal(statementOutcomeFor(action, 'tool entitlement missing or revoked'), 'not_allowed');
    assert.equal(statementOutcomeFor(action, 'its grant must not require approval'), 'not_allowed');
    assert.equal(statementOutcomeFor(action, 'socket hang up'), 'failed');
  }
  // Generation never reports a void-shaped outcome: its refusal set is its own.
  assert.equal(statementOutcomeFor('generate', 'void reason required'), 'failed');
});
