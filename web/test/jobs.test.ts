import assert from 'node:assert/strict';
import test from 'node:test';
import { adviceFor, isRetryOutcome, nextStep, RETRY_OUTCOMES, retryOutcomeFor, runsByJob, summarize, type JobRow } from '../lib/jobs';

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
  assert.deepEqual(s.counts, { pending: 1, running: 1, succeeded: 0, failed: 1, blocked: 2, quarantined: 1 });
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
      { job_key: 'x', attempt: 1, outcome: 'succeeded', finished_at: at(-20), detail: {} }], now);
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

test('every database refusal of a retry maps to a fixed operator message', () => {
  const cases: Array<[string, string]> = [
    ['business actions paused', 'paused'],
    ['tool entitlement missing or revoked', 'not_allowed'],
    ['agent disabled', 'not_allowed'],
    ['job changed since it was loaded', 'changed'],
    ['only blocked or quarantined jobs can be retried', 'not_stopped'],
    ['job no longer needed', 'not_needed'],
    ['retry reason required', 'reason'],
    ['job not found', 'not_found'],
    ['connection reset', 'failed'],
  ];
  for (const [message, outcome] of cases) assert.equal(retryOutcomeFor(message), outcome, message);
  assert.equal(RETRY_OUTCOMES.retried.ok, true);
  assert.ok(Object.entries(RETRY_OUTCOMES).every(([k, v]) => k === 'retried' || !v.ok));
});

test('only known retry outcomes are shown from the URL', () => {
  assert.equal(isRetryOutcome('retried'), true);
  for (const v of ['<script>', 'toString', '__proto__', '', undefined, ['retried']]) assert.equal(isRetryOutcome(v), false, String(v));
});
