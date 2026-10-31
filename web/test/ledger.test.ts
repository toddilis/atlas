import assert from 'node:assert/strict';
import test from 'node:test';
import { LEDGER_CSV_HEADER, centsToDecimal, exportPeriod, ledgerCsv } from '../lib/ledger-export';

test('cents become exact signed decimals, never floats (CLOSE-01d)', () => {
  assert.equal(centsToDecimal(0), '0.00');
  assert.equal(centsToDecimal(5), '0.05');
  assert.equal(centsToDecimal(24150), '241.50');
  assert.equal(centsToDecimal(-10350), '-103.50');
  // Beyond float-safe integers, BigInt keeps every digit.
  assert.equal(centsToDecimal('900719925474099312'), '9007199254740993.12');
});

test('the CSV quotes exactly the fields that need it and balances by construction', () => {
  const csv = ledgerCsv([
    { posted_at: '2026-10-23T01:00:00Z', occurred_at: '2026-10-23T01:00:00Z', transaction_id: 't1',
      source: 'invoice_issued', description: 'Invoice ATL-1 issued', account_code: '1100',
      account_name: 'Accounts Receivable', memo: 'AR receivable', amount_cents: 10350, currency: 'NZD' },
    { posted_at: '2026-10-23T01:00:00Z', occurred_at: '2026-10-23T01:00:00Z', transaction_id: 't1',
      source: 'invoice_issued', description: 'Invoice ATL-1 issued', account_code: '4000',
      account_name: 'Revenue, "wholesale"\nnet', memo: null, amount_cents: -10350, currency: 'NZD' },
  ]);
  const lines = csv.split('\r\n');
  assert.equal(lines[0], LEDGER_CSV_HEADER);
  assert.equal(lines[1], '2026-10-23T01:00:00Z,2026-10-23T01:00:00Z,t1,invoice_issued,Invoice ATL-1 issued,1100,Accounts Receivable,AR receivable,103.50,NZD');
  assert.equal(lines[2], '2026-10-23T01:00:00Z,2026-10-23T01:00:00Z,t1,invoice_issued,Invoice ATL-1 issued,4000,"Revenue, ""wholesale""\nnet",,-103.50,NZD');
  assert.equal(lines[3], '');
  assert.equal(ledgerCsv([]), LEDGER_CSV_HEADER + '\r\n');
});

test('the period is two UTC days with the end inclusive, or nothing', () => {
  assert.deepEqual(exportPeriod('2026-10-01', '2026-10-31'),
    { fromAt: '2026-10-01T00:00:00Z', toBefore: '2026-11-01T00:00:00.000Z' });
  assert.deepEqual(exportPeriod('2026-12-31', '2026-12-31'),
    { fromAt: '2026-12-31T00:00:00Z', toBefore: '2027-01-01T00:00:00.000Z' });
  assert.equal(exportPeriod('2026-10-31', '2026-10-01'), null);
  assert.equal(exportPeriod('yesterday', '2026-10-01'), null);
  assert.equal(exportPeriod('', ''), null);
});
