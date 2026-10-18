import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyInvoicePart, runInvoicePartJobs } from '../src/agents/controller/invoice-parts.js';
import type { JobsStore } from '../src/platform/jobs/store.js';

const ORG = '69000000-0000-4000-8000-000000000001';
const job = (n: number) => ({ org_id: ORG, job_key: `invoice-part:d${n}`, source_id: 'src', dispatch_id: `d${n}`, lease_token: `lease-${n}`, attempts: 1 });
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

test('each wholesale shipment is drafted, and what stops one is its recorded reason', async () => {
  const { store, finished } = fakeStore(3);
  const contexts: unknown[] = [];
  const result = await runInvoicePartJobs(ORG, { store, draft: async (context, dispatchId) => {
    contexts.push(context);
    if (dispatchId === 'd2') throw new Error('pricing: missing or expired carrier quote');
    if (dispatchId === 'd3') throw { message: 'stale part order; recalculate', code: 'P0001' };
    return { invoiceId: 'inv-1', snapshotId: 'snap-1', reused: false };
  } });
  assert.deepEqual(result, { discovered: 3, succeeded: 1, retrying: 1, blocked: 1, quarantined: 0, unfinished: 0 });
  assert.deepEqual(finished.map(f => f.outcome), ['succeeded', 'blocked', 'retry']);
  assert.deepEqual(finished[0]!.detail, { invoice_id: 'inv-1', snapshot_id: 'snap-1', reused: false });
  assert.deepEqual(finished[1]!.detail, { error: 'pricing: missing or expired carrier quote' });
  // The business comes from the worker's binding and the source from the job, never elsewhere.
  assert.deepEqual(contexts[0], { orgId: ORG, sourceId: 'src' });
});

test('races and outages are retried; missing records and refusals wait for a person or an event', () => {
  for (const m of ['stale part order; recalculate', 'stale or inactive pricing snapshot', 'order is being invoiced by BILL; retry',
    'dispatch is not eligible at the expected revision',
    'fetch failed', 'could not serialize access due to concurrent update', 'canceling statement due to statement timeout'])
    assert.equal(classifyInvoicePart(new Error(m)), 'retry', m);
  for (const m of ['billing: no pricing version is active; activate one in Pricing', 'order retailer unknown: link the Shopify customer to an account',
    'billing: no single active product for SKU WIDGET', 'pricing: missing or expired carrier quote', 'carrier cost requires stored carrier evidence',
    'an earlier shipment of this order must be invoiced first; it carries the order\'s freight', 'order already has a legacy invoice; reconcile first',
    'pricing: missing product p1', 'snapshot total arithmetic mismatch'])
    assert.equal(classifyInvoicePart(new Error(m)), 'blocked', m);
});
