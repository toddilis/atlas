import test from 'node:test';
import assert from 'node:assert/strict';
import { carrierCostSyncEnabled, classify, runCarrierCostJobs, type JobsStore } from '../src/platform/jobs/carrier-cost.js';

const ORG = '67000000-0000-4000-8000-000000000001';
const job = (n: number) => ({ org_id: ORG, job_key: `carrier-cost:d${n}`, source_id: 'src', dispatch_id: `d${n}`, lease_token: `lease-${n}`, attempts: 1 });

// In-memory store: hands out the queued jobs once and applies the database's outcome rules.
function fakeStore(count: number, quarantineKey?: string) {
  const queue = Array.from({ length: count }, (_, i) => job(i + 1));
  const finished: Array<{ key: string; outcome: string; detail: Record<string, unknown> }> = [];
  const store: JobsStore = {
    discover: async () => count,
    claim: async () => queue.shift() ?? null,
    finish: async (_org, j, outcome, detail) => {
      finished.push({ key: j.job_key!, outcome, detail });
      return j.job_key === quarantineKey ? 'quarantined' : outcome === 'retry' ? 'failed' : outcome;
    },
  };
  return { store, finished };
}

test('each claimed job is finished with the outcome of its sync', async () => {
  const { store, finished } = fakeStore(4, 'carrier-cost:d4');
  const sync = async (_c: { orgId: string; sourceId: string }, dispatchId: string) => {
    if (dispatchId === 'd2') throw new Error('GOSWEETSPOT_SITE_ID must be set');
    if (dispatchId === 'd3' || dispatchId === 'd4') throw new Error('gosweetspot: shipments lookup failed with HTTP 503');
    return { evidenceId: 'ev-1', costMinor: '858' };
  };
  const result = await runCarrierCostJobs(ORG, { store, sync });
  assert.deepEqual(result, { discovered: 4, succeeded: 1, retrying: 1, blocked: 1, quarantined: 1 });
  assert.deepEqual(finished.map(f => f.outcome), ['succeeded', 'blocked', 'retry', 'retry']);
  assert.deepEqual(finished[0]?.detail, { evidence_id: 'ev-1', cost_minor: '858' });
  assert.deepEqual(finished[1]?.detail, { error: 'GOSWEETSPOT_SITE_ID must be set' });
});

test('a pass runs at most the limit and stops when nothing is due', async () => {
  const { store, finished } = fakeStore(5);
  const ok = async () => ({ evidenceId: 'ev', costMinor: '1' });
  assert.equal((await runCarrierCostJobs(ORG, { store, sync: ok, limit: 3 })).succeeded, 3);
  assert.equal((await runCarrierCostJobs(ORG, { store, sync: ok })).succeeded, 2);
  assert.equal(finished.length, 5);
});

test('failures a person must fix are blocked; transient ones are retried', () => {
  for (const m of ['GOSWEETSPOT_ACCESS_KEY must be set', 'gosweetspot: unexpected shipments response shape; no cost recorded',
    'gosweetspot: response does not cover every tracking number of the dispatch', 'gosweetspot: the dispatch has no tracking number to look up',
    'gosweetspot: shipments lookup failed with HTTP 401', 'gosweetspot: shipments lookup failed with HTTP 403'])
    assert.equal(classify(new Error(m)), 'blocked', m);
  // Supabase RPC errors are plain objects carrying a message.
  assert.equal(classify({ message: 'carrier cost replay conflicts with recorded evidence', code: 'P0001' }), 'blocked');
  for (const m of ['gosweetspot: shipments lookup failed with HTTP 503', 'fetch failed', 'HTTP 429'])
    assert.equal(classify(new Error(m)), 'retry', m);
});

test('the sync is an optional module switched on by the access key', () => {
  assert.equal(carrierCostSyncEnabled({}), false);
  assert.equal(carrierCostSyncEnabled({ GOSWEETSPOT_ACCESS_KEY: '  ' }), false);
  assert.equal(carrierCostSyncEnabled({ GOSWEETSPOT_ACCESS_KEY: 'synthetic' }), true);
});
