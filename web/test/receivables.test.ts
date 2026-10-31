import assert from 'node:assert/strict';
import test from 'node:test';
import { ageInvoices, ageingByRetailer, overdueInvoices, totalsByCurrency, type OpenInvoiceRow } from '../lib/receivables';

const NZ = 'Pacific/Auckland';
const row = (over: Partial<OpenInvoiceRow>): OpenInvoiceRow => ({
  id: 'i', invoice_number: 'ATL-1', currency: 'NZD', total_cents: 10000, paid_cents: 0,
  issued_at: '2026-09-01T00:00:00Z', due_at: '2026-10-20T00:00:00Z', account_id: 'a', account_name: 'North', ...over,
});
// 31 Oct 2026, 09:00 in Auckland.
const AS_OF = new Date('2026-10-30T20:00:00Z');

test('days late count calendar days in the business timezone, from the due date (CLOSE-01e)', () => {
  // Due 20 Oct UTC midnight = 20 Oct 13:00 in Auckland; as of 31 Oct there: 11 days late.
  const [late] = ageInvoices([row({})], AS_OF, NZ);
  assert.equal(late.days_overdue, 11);
  assert.equal(late.bucket, '30');
  assert.equal(late.aged_from, 'due');
  // Due today is not late; due tomorrow is current too.
  const [today] = ageInvoices([row({ due_at: '2026-10-30T20:00:00Z' })], AS_OF, NZ);
  assert.equal(today.days_overdue, 0);
  assert.equal(today.bucket, 'current');
  // No due date: aged from the issue date, as statements do.
  const [noDue] = ageInvoices([row({ due_at: null, issued_at: '2026-07-01T00:00:00Z' })], AS_OF, NZ);
  assert.equal(noDue.aged_from, 'issued');
  assert.equal(noDue.bucket, '90_plus');
});

test('what is owed is the total less payments, and paid-off rows drop out', () => {
  const aged = ageInvoices([row({ id: 'p', paid_cents: 4000 }), row({ id: 'z', paid_cents: 10000 })], AS_OF, NZ);
  assert.deepEqual(aged.map(a => [a.id, a.outstanding_cents]), [['p', 6000]]);
});

test('retailers are rolled up per currency with buckets that sum to the outstanding', () => {
  const aged = ageInvoices([
    row({ id: '1', account_id: 'n', account_name: 'North', total_cents: 5000, due_at: '2026-11-20T00:00:00Z' }),
    row({ id: '2', account_id: 'n', account_name: 'North', total_cents: 7000, due_at: '2026-08-10T00:00:00Z' }),
    row({ id: '3', account_id: 's', account_name: 'South', total_cents: 3000, paid_cents: 1000 }),
    row({ id: '4', account_id: 'n', account_name: 'North', currency: 'AUD', total_cents: 2000 }),
  ], AS_OF, NZ);
  const retailers = ageingByRetailer(aged);
  assert.deepEqual(retailers.map(r => [r.account_name, r.currency, r.invoices, r.total_cents]),
    [['North', 'AUD', 1, 2000], ['North', 'NZD', 2, 12000], ['South', 'NZD', 1, 2000]]);
  const north = retailers.find(r => r.account_name === 'North' && r.currency === 'NZD')!;
  assert.equal(north.buckets.current, 5000);
  assert.equal(north.buckets['90'], 7000);
  for (const r of retailers) assert.equal(Object.values(r.buckets).reduce((n, v) => n + v, 0), r.total_cents);

  const totals = totalsByCurrency(retailers);
  assert.deepEqual(totals.map(t => [t.currency, t.total_cents, t.overdue_cents]), [['AUD', 2000, 2000], ['NZD', 14000, 9000]]);
  assert.deepEqual(overdueInvoices(aged).map(i => i.id), ['2', '3', '4']);
});
