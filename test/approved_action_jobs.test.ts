import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyApprovedAction, runApprovedActionJobs } from '../src/platform/jobs/approved-actions.js';
import type { JobsStore } from '../src/platform/jobs/store.js';

const ORG = '71000000-0000-4000-8000-000000000001';
const job = (n: number) => ({ org_id: ORG, job_key: `approved-action:a${n}`, source_id: null, dispatch_id: null, action_id: `a${n}`, lease_token: `lease-${n}`, attempts: 1 });
function fakeStore(count: number) {
  const queue = Array.from({ length: count }, (_, i) => job(i + 1));
  const finished: Array<{ key: string; outcome: string; detail: Record<string, unknown> }> = [];
  const store: JobsStore = {
    discover: async () => count,
    claim: async () => queue.shift() ?? null,
    finish: async (_org, j, outcome, detail) => { finished.push({ key: j.job_key!, outcome, detail }); return outcome === 'retry' ? 'failed' : outcome; },
  };
  return { store, finished };
}

test('approved actions execute with their evidence recorded; what stops one is its reason', async () => {
  const { store, finished } = fakeStore(3);
  const contexts: unknown[] = [];
  const result = await runApprovedActionJobs(ORG, { store, execute: async (context) => {
    contexts.push(context);
    if (context.actionId === 'a2') throw new Error('current policy blocks action: cap exceeded');
    if (context.actionId === 'a3') throw { message: 'fetch failed', code: 'X' };
    return { approval_id: 'ap-1', action_id: context.actionId, execution_id: 'ex-1', status: 'CONFIRMED' };
  } });
  assert.deepEqual(result, { discovered: 3, succeeded: 1, retrying: 1, blocked: 1, quarantined: 0, unfinished: 0 });
  assert.deepEqual(finished.map(f => f.outcome), ['succeeded', 'blocked', 'retry']);
  assert.deepEqual(finished[0]!.detail, { approval_id: 'ap-1', action_id: 'a1', execution_id: 'ex-1', status: 'CONFIRMED' });
  assert.deepEqual(finished[1]!.detail, { error: 'current policy blocks action: cap exceeded' });
  // The business comes from the worker's binding and the action from the job, never elsewhere.
  assert.deepEqual(contexts[0], { orgId: ORG, actionId: 'a1' });
});

test('outages retry; changed policy or subject, uncertain results and refusals wait for a person', () => {
  for (const m of ['fetch failed', 'could not serialize access due to concurrent update', 'canceling statement due to statement timeout'])
    assert.equal(classifyApprovedAction(new Error(m)), 'retry', m);
  for (const m of ['policy changed; new approval required', 'material subject changed; new approval required',
    'approval not valid', 'approval is not pending or has expired/revoked',
    'action already claimed or unresolved; reconcile first', 'unknown stored tool x',
    'stored tool lacks material-state contract', 'policy configured but stored tool has no extractor',
    'current policy blocks action: cap', 'tool entitlement missing or revoked', 'agent disabled',
    'execution unresolved: no confirmation evidence for action a1'])
    assert.equal(classifyApprovedAction(new Error(m)), 'blocked', m);
});
