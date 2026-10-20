import assert from 'node:assert/strict';
import test from 'node:test';
import type { JobRow } from '../lib/jobs';
import {
  draftParts, expiringSoon, jobAttention, lastSuccessByJob, nextSyncAt, receivables, sourceFreshness, withinLastDay,
  type SyncSourceRow, type TodayInvoiceRow,
} from '../lib/today';

const now = new Date('2026-10-20T12:00:00Z');
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
const invoice = (extra: Partial<TodayInvoiceRow>): TodayInvoiceRow => ({
  id: 'i', state: 'issued', currency: 'NZD', total_cents: 1000, due_at: at(60), issued_at: at(-60), created_at: at(-120), snapshot: null, ...extra,
});
const source = (extra: Partial<SyncSourceRow> = {}): SyncSourceRow =>
  ({ id: 's1', connection_key: 'x.myshopify.com', enabled: true, sync_every_minutes: 15, ...extra });
const job = (key: string, kind: string, state: JobRow['state'], nextAt: string): JobRow => ({
  job_key: key, kind, state, attempts: 1, next_attempt_at: nextAt, lease_until: null, last_error: null,
  created_at: at(-240), updated_at: at(-10), dispatch_id: null,
});

test('receivables group by currency and call overdue only past the stored due time', () => {
  const rows = receivables([
    invoice({ id: 'a', total_cents: 1000 }),
    invoice({ id: 'b', state: 'partial', total_cents: 500, due_at: at(-1) }),
    invoice({ id: 'c', currency: 'AUD', total_cents: 700, due_at: null }),
    invoice({ id: 'd', state: 'draft' }),
    invoice({ id: 'e', state: 'paid', due_at: at(-500) }),
  ], now);
  assert.deepEqual(rows, [
    { currency: 'AUD', count: 1, totalCents: 700, overdueCount: 0, overdueCents: 0 },
    { currency: 'NZD', count: 2, totalCents: 1500, overdueCount: 1, overdueCents: 500 },
  ]);
});

test('only drafts with a calculation snapshot are parts to approve and issue', () => {
  const rows = draftParts([
    invoice({ id: 'a', state: 'draft', snapshot: { id: 's' } }),
    invoice({ id: 'b', state: 'draft', snapshot: [] }),
    invoice({ id: 'c', state: 'draft', snapshot: [{ id: 's' }] }),
    invoice({ id: 'd', state: 'issued', snapshot: { id: 's' } }),
  ]);
  assert.deepEqual(rows.map(r => r.id), ['a', 'c']);
});

test('a connection is stale after three cadences, never before thirty minutes', () => {
  assert.deepEqual(sourceFreshness(source(), null, now), { state: 'never' });
  assert.equal(sourceFreshness(source(), at(-44), now).state, 'fresh');
  assert.equal(sourceFreshness(source(), at(-46), now).state, 'stale');
  // A one-minute cadence still gets the 30-minute floor.
  assert.equal(sourceFreshness(source({ sync_every_minutes: 1 }), at(-29), now).state, 'fresh');
  assert.equal(sourceFreshness(source({ sync_every_minutes: 1 }), at(-31), now).state, 'stale');
});

test('the latest success per job wins whatever the order of runs', () => {
  const last = lastSuccessByJob([
    { job_key: 'shopify-sync:s1', outcome: 'succeeded', finished_at: at(-50) },
    { job_key: 'shopify-sync:s1', outcome: 'succeeded', finished_at: at(-10) },
    { job_key: 'shopify-sync:s1', outcome: 'retry', finished_at: at(-1) },
    { job_key: 'shopify-sync:s2', outcome: 'blocked', finished_at: at(-5) },
  ]);
  assert.equal(last.get('shopify-sync:s1'), at(-10));
  assert.equal(last.has('shopify-sync:s2'), false);
});

test('job attention counts stopped, retrying, running and due work', () => {
  const summary = jobAttention([
    job('a', 'carrier_cost_sync', 'blocked', at(-1)),
    job('b', 'invoice_part_draft', 'blocked', at(360)),
    job('c', 'shopify_sync', 'quarantined', at(-600)),
    job('d', 'carrier_cost_sync', 'failed', at(-2)),
    job('e', 'shopify_sync', 'pending', at(-1)),
    job('f', 'approved_action_execute', 'running', at(0)),
  ], now);
  assert.deepEqual(summary, { blocked: 2, quarantined: 1, retrying: 1, running: 1, dueNow: 3 });
});

test('the next armed sync and expiring approvals read from the rows alone', () => {
  assert.equal(nextSyncAt([
    job('shopify-sync:s1', 'shopify_sync', 'blocked', at(90)),
    job('shopify-sync:s2', 'shopify_sync', 'pending', at(5)),
    job('x', 'carrier_cost_sync', 'pending', at(1)),
  ]), at(5));
  assert.equal(nextSyncAt([job('x', 'shopify_sync', 'running', at(1))]), null);
  assert.equal(expiringSoon([at(60), at(60 * 25), at(-5), null], now), 1);
  assert.equal(withinLastDay(at(-60 * 23), now), true);
  assert.equal(withinLastDay(at(-60 * 25), now), false);
  assert.equal(withinLastDay(at(5), now), false);
  assert.equal(withinLastDay(null, now), false);
});
