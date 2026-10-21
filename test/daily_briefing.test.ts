import test from 'node:test';
import assert from 'node:assert/strict';
import { assertGrounded, generateDailyBriefing, parseNarration, type BriefingSnapshot } from '../src/platform/assistant/briefing.js';
import { classifyDailyBriefing, narrationEnabled, runDailyBriefingJobs } from '../src/platform/jobs/daily-briefing.js';
import type { JobsStore } from '../src/platform/jobs/store.js';

const ORG = '72000000-0000-4000-8000-000000000001';
const snapshot: BriefingSnapshot = {
  businessId: ORG, generatedAt: '2026-10-20T20:00:00Z',
  facts: {
    paused: false, pendingApprovals: 2, approvalsExpiringWithinDay: 0, blockedJobs: 3, quarantinedJobs: 1,
    draftPartsAwaitingIssue: 0, uncertainExecutions: 0,
    outstanding: [{ currency: 'NZD', count: 4, total: '1234.56 NZD' }],
    overdue: [{ currency: 'NZD', count: 1, total: '103.50 NZD' }],
    connections: [{ connection: 'vice.myshopify.com', lastSuccessfulSyncAt: null }],
    last24h: { partsDrafted: 0, invoicesIssued: 0, syncsSucceeded: 0, costsRecorded: 0, approvalsDecided: 0 },
  },
  refs: [{ kind: 'invoice', id: 'inv-1', label: 'overdue invoice #5002A' }],
};

test('grounding accepts only the facts\' own numbers and records', () => {
  assertGrounded(snapshot, 'Two approvals wait, 3 jobs are blocked and 1 invoice is overdue for 103.50 NZD.', ['inv-1']);
  assert.throws(() => assertGrounded(snapshot, 'About 7 invoices are overdue.', []), /introduces the number 7/);
  assert.throws(() => assertGrounded(snapshot, 'Roughly 12.50 NZD is overdue.', []), /introduces the number 12/);
  assert.throws(() => assertGrounded(snapshot, 'All quiet.', ['inv-999']), /unknown record inv-999/);
  assert.throws(() => assertGrounded(snapshot, '   ', []), /empty or too long/);
  assert.throws(() => assertGrounded(snapshot, 'x'.repeat(701), []), /empty or too long/);
});

test('the output contract is enforced before grounding', () => {
  assert.deepEqual(parseNarration('{"narration":"Quiet day.","refIds":[]}'), { narration: 'Quiet day.', refIds: [] });
  assert.throws(() => parseNarration('Quiet day.'), /was not the agreed JSON/);
  assert.throws(() => parseNarration('{"narration":1,"refIds":[]}'), /was not the agreed JSON/);
  assert.throws(() => parseNarration('{"narration":"x","refIds":[1]}'), /was not the agreed JSON/);
});

test('a grounded narration is stored ok; an ungrounded one is stored rejected and surfaces', async () => {
  const recorded: Array<{ status: string; narration: string | null; error: string | null; refs: unknown[] }> = [];
  const record = async (args: { status: 'ok' | 'rejected'; narration: string | null; error: string | null; refs: unknown[] }) => {
    recorded.push({ status: args.status, narration: args.narration, error: args.error, refs: args.refs });
    return 'briefing-1';
  };
  const ok = await generateDailyBriefing(ORG, {
    load: async () => snapshot, record,
    narrate: async () => ({ narration: '2 approvals wait; 1 invoice is overdue (103.50 NZD).', refIds: ['inv-1'], model: 'test-model' }),
  });
  assert.deepEqual(ok, { status: 'ok', briefingId: 'briefing-1', model: 'test-model' });
  assert.equal(recorded[0]!.status, 'ok');
  assert.deepEqual(recorded[0]!.refs, snapshot.refs);

  await assert.rejects(generateDailyBriefing(ORG, {
    load: async () => snapshot, record,
    narrate: async () => ({ narration: 'You made 9999 dollars today!', refIds: [], model: 'test-model' }),
  }), /introduces the number 9999/);
  assert.equal(recorded[1]!.status, 'rejected');
  assert.equal(recorded[1]!.narration, null);
  assert.match(recorded[1]!.error ?? '', /introduces the number 9999/);
});

test('the briefing job records outcomes; what stops one is its reason', async () => {
  const job = { org_id: ORG, job_key: `daily-briefing:${ORG}`, source_id: null, dispatch_id: null, action_id: null, lease_token: 'lease-1', attempts: 1 };
  const finished: Array<{ outcome: string; detail: Record<string, unknown> }> = [];
  const store: JobsStore = {
    discover: async () => 1,
    claim: async () => (finished.length === 0 ? job : null),
    finish: async (_org, _j, outcome, detail) => { finished.push({ outcome, detail }); return outcome === 'retry' ? 'failed' : outcome; },
  };
  const result = await runDailyBriefingJobs(ORG, { store, generate: async () => ({ status: 'ok', briefingId: 'b-1', model: 'test-model' }) });
  assert.deepEqual(result, { discovered: 1, succeeded: 1, retrying: 0, blocked: 0, quarantined: 0, unfinished: 0 });
  assert.deepEqual(finished[0]!.detail, { briefing_id: 'b-1', model: 'test-model', status: 'ok' });
});

test('rejections and refusals wait for a person; outages retry', () => {
  for (const m of ['briefing rejected: narration introduces the number 7, which is not in the facts',
    'briefing rejected: narration was not the agreed JSON', 'briefing rejected: narration stopped early (refusal)',
    'ANTHROPIC_API_KEY must be set', 'authentication_error: invalid x-api-key', 'Your credit balance is too low'])
    assert.equal(classifyDailyBriefing(new Error(m)), 'blocked', m);
  for (const m of ['fetch failed', 'Internal server error', '429 rate_limit_error: slow down', 'overloaded_error'])
    assert.equal(classifyDailyBriefing(new Error(m)), 'retry', m);
  assert.equal(narrationEnabled({}), false);
  assert.equal(narrationEnabled({ ANTHROPIC_API_KEY: ' ' }), false);
  assert.equal(narrationEnabled({ ANTHROPIC_API_KEY: 'sk-ant-x' }), true);
});
