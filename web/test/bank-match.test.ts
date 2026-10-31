import assert from 'node:assert/strict';
import test from 'node:test';
import { allocateOutcomeFor, classifyReceipt, matchSummary, namesInvoice, reviewOutcomeFor, type OpenInvoice } from '../lib/bank-match';

const inv = (invoice_number: string, outstanding_cents: number, currency = 'NZD'): OpenInvoice =>
  ({ id: `id-${invoice_number}`, invoice_number, currency, outstanding_cents });
const line = (amount_cents: number, reference: string | null, description = 'DIRECT CREDIT', extra: Partial<{ allocated_cents: number; not_receipt: boolean; currency: string }> = {}) =>
  ({ amount_cents, reference, description, currency: 'NZD', allocated_cents: 0, not_receipt: false, ...extra });

test('an invoice is named by its letter and digit runs, never inside a longer code (FLOW-01B-b)', () => {
  assert.equal(namesInvoice('ATL-0001A', 'ATL-0001A'), true);
  assert.equal(namesInvoice('inv atl 0001a thanks', 'ATL-0001A'), true);
  assert.equal(namesInvoice('ATL0001A', 'ATL-0001A'), true);
  assert.equal(namesInvoice('Payment: ATL - 0001A,', 'ATL-0001A'), true);
  // A shorter or longer code is a different invoice.
  assert.equal(namesInvoice('ATL-0001A', 'ATL-0001'), false);
  assert.equal(namesInvoice('ATL-0001', 'ATL-0001A'), false);
  assert.equal(namesInvoice('XATL-0001A', 'ATL-0001A'), false);
  assert.equal(namesInvoice('ATL-00012', 'ATL-0001'), false);
  // Too short to be evidence on its own.
  assert.equal(namesInvoice('12', '#12'), false);
  assert.equal(namesInvoice('order 1234A', '#1234A'), true);
});

test('a named invoice with the exact outstanding amount is a full proposal', () => {
  const open = [inv('ATL-0001A', 14150), inv('ATL-0002', 5000)];
  const m = classifyReceipt(line(14150, 'ATL-0001A'), open);
  assert.equal(m.kind, 'exact');
  assert.ok('allocations' in m);
  assert.deepEqual(m.allocations.map(a => [a.invoice.invoice_number, a.amount_cents]), [['ATL-0001A', 14150]]);
  // The description counts as evidence too.
  assert.equal(classifyReceipt(line(5000, null, 'DIRECT CREDIT ATL-0002 RETAILER'), open).kind, 'exact');
});

test('less, more, several and none are said plainly', () => {
  const open = [inv('ATL-0001A', 14150), inv('ATL-0001B', 2000), inv('ATL-0003', 7500), inv('ATL-0004', 7500), inv('AUD-0001', 4000, 'AUD')];
  assert.equal(classifyReceipt(line(10000, 'ATL-0001A'), open).kind, 'partial');
  const excess = classifyReceipt(line(15000, 'ATL-0001A'), open);
  assert.equal(excess.kind, 'excess');
  assert.ok(excess.kind === 'excess' && excess.leftover_cents === 850 && excess.allocations[0].amount_cents === 14150);
  const split = classifyReceipt(line(16150, 'ATL-0001A ATL-0001B'), open);
  assert.equal(split.kind, 'split');
  assert.equal(classifyReceipt(line(9999, 'ATL-0001A ATL-0001B'), open).kind, 'ambiguous');
  // An amount alone is a candidate that says so; two invoices with that amount are ambiguous.
  assert.equal(classifyReceipt(line(2000, 'thanks'), open).kind, 'amount_only');
  assert.equal(classifyReceipt(line(7500, null), open).kind, 'ambiguous');
  assert.equal(classifyReceipt(line(1234, 'no idea'), open).kind, 'unmatched');
  // Another currency's invoice never matches, even by name.
  assert.equal(classifyReceipt(line(4000, 'AUD-0001'), open).kind, 'unmatched');
});

test('debits, marked lines and spent lines are not proposals; a remainder is matched on what is left', () => {
  const open = [inv('ATL-0001A', 14150), inv('ATL-0009', 850)];
  assert.equal(classifyReceipt(line(-1000, 'ATL-0001A'), open).kind, 'debit');
  assert.equal(classifyReceipt(line(14150, 'ATL-0001A', 'X', { not_receipt: true }), open).kind, 'not_receipt');
  assert.equal(classifyReceipt(line(14150, null, 'X', { allocated_cents: 14150 }), open).kind, 'settled');
  // 15000 already paid 14150 elsewhere; the 850 left matches ATL-0009 by amount.
  assert.equal(classifyReceipt(line(15000, null, 'X', { allocated_cents: 14150 }), open).kind, 'amount_only');
});

test('the summary names the evidence, and an amount-only candidate asks for judgement', () => {
  const money = (c: number) => `$${(c / 100).toFixed(2)}`;
  const open = [inv('ATL-0001A', 14150)];
  assert.equal(matchSummary(classifyReceipt(line(14150, 'ATL-0001A'), open), money), 'Pays ATL-0001A in full; the invoice is named in the bank reference.');
  assert.equal(matchSummary(classifyReceipt(line(10000, 'ATL-0001A'), open), money), 'Part-pays ATL-0001A: $100.00 of $141.50 outstanding.');
  assert.match(matchSummary(classifyReceipt(line(14150, null), open), money), /does not name it\. Confirm only if you know/);
  assert.equal(matchSummary(classifyReceipt(line(1, null), open), money), 'No open invoice is named in the reference or has this amount outstanding.');
});

test('database refusals map to fixed outcomes', () => {
  assert.equal(allocateOutcomeFor('tool entitlement missing or revoked'), 'not_allowed');
  assert.equal(allocateOutcomeFor('business actions paused'), 'paused');
  assert.equal(allocateOutcomeFor('bank line not found'), 'line_not_found');
  assert.equal(allocateOutcomeFor('only a credit bank line can pay an invoice'), 'line_debit');
  assert.equal(allocateOutcomeFor('this bank line is marked as not a receipt'), 'line_not_receipt');
  assert.equal(allocateOutcomeFor('payment exceeds what remains on this bank line'), 'line_exceeds');
  assert.equal(allocateOutcomeFor('this bank line already pays this invoice a different amount'), 'pair_conflict');
  assert.equal(allocateOutcomeFor('the bank line and the invoice are in different currencies'), 'currency_mismatch');
  assert.equal(allocateOutcomeFor('payment exceeds what is outstanding on this invoice'), 'invoice_exceeds');
  assert.equal(allocateOutcomeFor('this invoice is already fully paid; an overpayment or refund is an explicit correction, not a payment entry'), 'invoice_unpayable');
  assert.equal(allocateOutcomeFor('only an issued invoice can receive a payment'), 'invoice_unpayable');
  assert.equal(allocateOutcomeFor('invoice not found'), 'invoice_not_found');
  assert.equal(allocateOutcomeFor('deadlock detected'), 'failed');

  assert.equal(reviewOutcomeFor('a reason is required'), 'reason_required');
  assert.equal(reviewOutcomeFor('this bank line already pays an invoice'), 'line_allocated');
  assert.equal(reviewOutcomeFor('only a credit bank line can be marked as not a receipt'), 'line_debit');
  assert.equal(reviewOutcomeFor('this bank line is already marked as not a receipt'), 'already_marked');
  assert.equal(reviewOutcomeFor('this bank line is not marked as not a receipt'), 'not_marked');
  assert.equal(reviewOutcomeFor('bank line decision required'), 'failed');
});
