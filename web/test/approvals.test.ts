import assert from 'node:assert/strict';
import test from 'node:test';
import {
  APPROVAL_OUTCOMES, decideOutcomeFor, executionStatus, extractReasons, isApprovalOutcome, isExpired, lastErrorByAction,
  type ApprovalListRow, type BoundActionRow,
} from '../lib/approvals';

const now = new Date('2026-10-18T12:00:00Z');
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
const approval = (state: ApprovalListRow['state'], extra: Partial<ApprovalListRow> = {}): ApprovalListRow => ({
  id: 'ap-1', agent_name: 'controller', action: 'demo.restock', subject_type: 'observation', subject_id: null,
  payload: {}, proposed_summary: null, risk: 'approve_required', state, decided_by: 'ops@example.test',
  decided_at: at(-5), reason: 'fine', created_at: at(-60), expires_at: at(60), ...extra,
});
const action = (state: BoundActionRow['state'], extra: Partial<BoundActionRow> = {}): BoundActionRow => ({
  approval_id: 'ap-1', id: 'ac-1', state, revoked_at: null, updated_at: at(-1), ...extra,
});

test('execution status explains each stage in operator words', () => {
  assert.equal(executionStatus(approval('pending'), action('PREPARED'), null, now), null);
  assert.equal(executionStatus(approval('rejected'), action('PREPARED'), null, now), null);
  assert.match(executionStatus(approval('approved'), action('AUTHORISED'), null, now)!, /worker executes it on its next pass/);
  assert.match(executionStatus(approval('approved', { expires_at: at(-1) }), action('AUTHORISED'), null, now)!, /expired before the worker ran it/);
  assert.match(executionStatus(approval('approved'), action('EXECUTING'), null, now)!, /Running now/);
  assert.match(executionStatus(approval('approved'), action('CONFIRMED'), null, now)!, /confirmed with evidence/);
  assert.match(executionStatus(approval('approved'), action('FAILED'), 'provider said no', now)!, /failed with no effect: provider said no/);
  assert.match(executionStatus(approval('approved'), action('UNRESOLVED'), null, now)!, /needs reconciliation/);
  assert.match(executionStatus(approval('approved'), action('AUTHORISED', { revoked_at: at(-1) }), null, now)!, /Revoked after approval/);
  assert.match(executionStatus(approval('approved'), undefined, null, now)!, /will not execute/);
});

test('decision refusals map to fixed outcomes, never raw text', () => {
  assert.equal(decideOutcomeFor('business actions paused'), 'paused');
  assert.equal(decideOutcomeFor('tool entitlement missing or revoked'), 'not_allowed');
  assert.equal(decideOutcomeFor('deciding approvals cannot itself require an approval; its grant must not require approval'), 'not_allowed');
  assert.equal(decideOutcomeFor('approval is not pending or has expired/revoked'), 'not_pending');
  assert.equal(decideOutcomeFor('legacy/unbound approval must be prepared again'), 'legacy');
  assert.equal(decideOutcomeFor('policy changed; prepare again'), 'policy_changed');
  assert.equal(decideOutcomeFor('decision reason required'), 'reason');
  assert.equal(decideOutcomeFor('something else entirely'), 'failed');
  for (const key of Object.keys(APPROVAL_OUTCOMES)) assert.equal(isApprovalOutcome(key), true, key);
  assert.equal(isApprovalOutcome('rm -rf'), false);
});

test('expiry, reasons and last attempt errors read from the rows alone', () => {
  assert.equal(isExpired(approval('pending', { expires_at: at(-1) }), now), true);
  assert.equal(isExpired(approval('pending', { expires_at: null }), now), false);
  assert.deepEqual(extractReasons({ decision: { reasons: ['cap', 7, 'window'] } }), ['cap', 'window']);
  assert.deepEqual(extractReasons({}), []);
  const errors = lastErrorByAction([
    { action_id: 'ac-1', attempt_number: 1, state: 'FAILED', error: 'first', finished_at: at(-10) },
    { action_id: 'ac-1', attempt_number: 2, state: 'FAILED', error: 'second', finished_at: at(-5) },
    { action_id: 'ac-2', attempt_number: 1, state: 'CONFIRMED', error: null, finished_at: at(-5) },
  ]);
  assert.equal(errors.get('ac-1'), 'second');
  assert.equal(errors.get('ac-2'), null);
});
