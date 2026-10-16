import assert from 'node:assert/strict';
import test from 'node:test';
import { adviceFor, isActionOutcome, isManualCost, nextStep, ACTION_OUTCOMES, actionOutcomeFor, runsByJob, summarize, type JobRow } from '../lib/jobs';

const now = new Date('2026-10-16T12:00:00Z');
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
const job = (key: string, state: JobRow['state'], extra: Partial<JobRow> = {}): JobRow => ({
  job_key: key, kind: 'carrier_cost_sync', state, attempts: 1, next_attempt_at: at(0), lease_until: null,
  last_error: null, created_at: at(-120), updated_at: at(-60), dispatch_id: `d-${key}`, ...extra,
});

test('quarantined then blocked jobs need a person; retrying and queued are separate', () => {
  const s = summarize([
    job('b-old', 'blocked', { updated_at: at(-300), next_attempt_at: at(60) }),
    job('q', 'quarantined', { attempts: 8 }),
    job('b-new', 'blocked', { updated_at: at(-5), next_attempt_at: at(300) }),
    job('f', 'failed', { next_attempt_at: at(4) }),
    job('p', 'pending'),
    job('r', 'running', { lease_until: at(3) }),
  ], [], now);
  assert.deepEqual(s.needsAttention.map(j => j.job_key), ['q', 'b-new', 'b-old']);
  assert.deepEqual(s.retrying.map(j => j.job_key), ['f']);
  assert.deepEqual(s.inProgress.map(j => j.job_key).sort(), ['p', 'r']);
  assert.deepEqual(s.counts, { pending: 1, running: 1, succeeded: 0, failed: 1, blocked: 2, quarantined: 1, dismissed: 0 });
  assert.deepEqual(s.overdue, []);
  assert.equal(s.lastRunAt, null);
});

test('due work the worker has not picked up for over 10 minutes is overdue', () => {
  const s = summarize([
    job('late', 'pending', { next_attempt_at: at(-11) }),
    job('just-due', 'failed', { next_attempt_at: at(-9) }),
    job('dead-lease', 'running', { lease_until: at(-15) }),
    job('stopped', 'quarantined', { next_attempt_at: at(-600) }),
  ], [{ job_key: 'late', attempt: 1, outcome: 'retry', finished_at: at(-30), detail: {} },
      { job_key: 'x', attempt: 1, outcome: 'succeeded', finished_at: at(-20), detail: {} },
      // An operator action is not the worker running.
      { job_key: 'x', attempt: 1, outcome: 'operator_retry', finished_at: at(-1), detail: {} }], now);
  assert.deepEqual(s.overdue.map(j => j.job_key), ['late', 'dead-lease']);
  assert.equal(s.lastRunAt, at(-20));
});

test('next step says when and how a job continues', () => {
  assert.equal(nextStep(job('a', 'blocked', { attempts: 2, next_attempt_at: at(330) }), now), 'Next attempt in 5 h 30 min (attempt 3 of 8).');
  assert.equal(nextStep(job('a', 'failed', { attempts: 3, next_attempt_at: at(8) }), now), 'Next attempt in 8 min (attempt 4 of 8).');
  assert.equal(nextStep(job('a', 'pending', { attempts: 0, next_attempt_at: at(-1) }), now), 'Due now (attempt 1 of 8).');
  assert.match(nextStep(job('a', 'quarantined', { attempts: 8 }), now), /Stopped after 8 attempts\. Atlas will not retry/);
  assert.match(nextStep(job('a', 'running', { lease_until: at(-1) }), now), /stopped during this run/);
  assert.equal(nextStep(job('a', 'running', { lease_until: at(4) }), now), 'Running now.');
});

test('every reason the runner blocks on has operator advice', () => {
  for (const reason of [
    'GOSWEETSPOT_SITE_ID must be set',
    'gosweetspot: shipments lookup failed with HTTP 401',
    'gosweetspot: unexpected shipments response shape; no cost recorded',
    'gosweetspot: response does not cover every tracking number of the dispatch',
    'gosweetspot: the dispatch has no tracking number to look up',
    'gosweetspot: no Shopify fulfillment for this dispatch',
    'gosweetspot: cost must be a non-negative amount with at most two decimals',
    'carrier evidence replay conflicts with the stored record',
    'lease expired before the run finished',
  ]) assert.ok(adviceFor(reason), reason);
  assert.equal(adviceFor('fetch failed'), null);
  assert.equal(adviceFor(null), null);
});

test('attempt history is grouped per job, newest first', () => {
  const runs = runsByJob([
    { job_key: 'a', attempt: 1, outcome: 'retry', finished_at: at(-30), detail: {} },
    { job_key: 'b', attempt: 1, outcome: 'blocked', finished_at: at(-20), detail: {} },
    { job_key: 'a', attempt: 2, outcome: 'blocked', finished_at: at(-10), detail: {} },
  ]);
  assert.deepEqual(runs.get('a')?.map(r => r.attempt), [2, 1]);
  assert.equal(runs.get('b')?.length, 1);
});

test('every database refusal of a retry or dismissal maps to a fixed operator message', () => {
  const cases: Array<[string, string]> = [
    ['business actions paused', 'paused'],
    ['tool entitlement missing or revoked', 'not_allowed'],
    ['agent disabled', 'not_allowed'],
    ['job changed since it was loaded', 'changed'],
    ['only blocked, quarantined or dismissed jobs can be retried', 'not_stopped'],
    ['only blocked or quarantined jobs can be dismissed', 'not_stopped'],
    ['dismiss reason required', 'reason'],
    ['cost reason required', 'reason'],
    ['only dismissed jobs can take a manual carrier cost', 'not_stopped'],
    ['carrier cost must be an amount with at most two decimals', 'cost_format'],
    ['order currency unknown', 'currency'],
    ['job no longer needed', 'not_needed'],
    ['retry reason required', 'reason'],
    ['job not found', 'not_found'],
    ['connection reset', 'failed'],
  ];
  for (const [message, outcome] of cases) assert.equal(actionOutcomeFor(message), outcome, message);
  assert.ok(ACTION_OUTCOMES.retried.ok && ACTION_OUTCOMES.dismissed.ok && ACTION_OUTCOMES.cost_recorded.ok);
  assert.ok(Object.entries(ACTION_OUTCOMES).every(([k, v]) => ['retried', 'dismissed', 'cost_recorded'].includes(k) || !v.ok));
});

test('only known action outcomes are shown from the URL', () => {
  assert.equal(isActionOutcome('retried'), true);
  assert.equal(isActionOutcome('dismissed'), true);
  for (const v of ['<script>', 'toString', '__proto__', '', undefined, ['retried']]) assert.equal(isActionOutcome(v), false, String(v));
});

test('dismissed jobs are listed apart, never overdue, and say what dismissal leaves undone', () => {
  const s = summarize([job('d', 'dismissed', { next_attempt_at: at(-600), attempts: 3 }), job('b', 'blocked', { next_attempt_at: at(60) })], [], now);
  assert.deepEqual(s.dismissed.map(j => j.job_key), ['d']);
  assert.deepEqual(s.needsAttention.map(j => j.job_key), ['b']);
  assert.equal(s.counts.dismissed, 1);
  assert.deepEqual(s.overdue, []);
  assert.match(nextStep(job('d', 'dismissed'), now), /will not retry it.*cannot be drafted until a cost is recorded/);
});

test('a typed carrier cost is accepted only as digits with at most two decimals', () => {
  for (const ok of ['0', '12', '12.5', '12.50', ' 18.40 ', '999999999.99']) assert.equal(isManualCost(ok), true, ok);
  for (const bad of ['', '12.345', '-1', '1,50', '$12', '1e3', '.5', '12.', 'NaN', '1234567890']) assert.equal(isManualCost(bad), false, bad);
});
