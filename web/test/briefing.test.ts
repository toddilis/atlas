import assert from 'node:assert/strict';
import test from 'node:test';
import { briefingView, refHref, type BriefingRow } from '../lib/briefing';

const now = new Date('2026-10-20T20:00:00Z');
const at = (hours: number) => new Date(now.getTime() + hours * 60 * 60_000).toISOString();
const row = (extra: Partial<BriefingRow> = {}): BriefingRow => ({
  generated_at: at(-2), narration: 'Two approvals wait.', refs: [{ kind: 'invoice', id: 'i1', label: 'overdue invoice' }],
  status: 'ok', model: 'm', ...extra,
});

test('only a fresh, grounded briefing is the day\'s briefing; everything else is an explicit absence', () => {
  assert.equal(briefingView(row(), now).state, 'fresh');
  assert.equal(briefingView(null, now).state, 'absent');
  assert.equal(briefingView(row({ generated_at: at(-27) }), now).state, 'absent');
  assert.equal(briefingView(row({ status: 'rejected', narration: null }), now).state, 'absent');
  assert.equal(briefingView(row({ narration: null }), now).state, 'absent');
  const fresh = briefingView(row(), now);
  assert.equal(fresh.state === 'fresh' && fresh.refs.length, 1);
});

test('cited records link to where they live in the console', () => {
  assert.equal(refHref({ kind: 'approval', id: 'a', label: '' }), '/approvals');
  assert.equal(refHref({ kind: 'job', id: 'j', label: '' }), '/jobs');
  assert.equal(refHref({ kind: 'invoice', id: 'i-9', label: '' }), '/invoices/i-9');
});
