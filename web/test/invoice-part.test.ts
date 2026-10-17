import assert from 'node:assert/strict';
import test from 'node:test';
import { currentPrint, invoiceOutcomeFor, isInvoiceOutcome, partLetter } from '../lib/invoice-part';

test('approval refusals map to fixed messages', () => {
  assert.equal(invoiceOutcomeFor('approve', 'invoice changed since it was loaded'), 'changed');
  assert.equal(invoiceOutcomeFor('approve', 'invoice snapshot changed or wrong business'), 'changed');
  assert.equal(invoiceOutcomeFor('approve', 'invoice is not a draft'), 'not_draft');
  assert.equal(invoiceOutcomeFor('approve', 'only invoice parts drafted from a dispatch can be approved here'), 'not_part');
  assert.equal(invoiceOutcomeFor('approve', 'tool entitlement missing or revoked'), 'issue_off');
  assert.equal(invoiceOutcomeFor('approve', 'current policy per-transaction cap blocks action'), 'policy');
  assert.equal(invoiceOutcomeFor('approve', 'current policy velocity limit blocks action'), 'policy');
  assert.equal(invoiceOutcomeFor('approve', 'issue_invoice_atomic: missing wholesale chart of accounts for org x'), 'ledger');
  assert.equal(invoiceOutcomeFor('approve', 'business actions paused'), 'paused');
  assert.equal(invoiceOutcomeFor('approve', 'connection reset'), 'failed');
});

test('print refusals map to fixed messages, and grants are told apart by action', () => {
  assert.equal(invoiceOutcomeFor('print', 'say what went wrong'), 'note');
  assert.equal(invoiceOutcomeFor('print', 'only an issued invoice can be printed'), 'not_issued');
  assert.equal(invoiceOutcomeFor('print', 'document changed since it was loaded'), 'document_changed');
  assert.equal(invoiceOutcomeFor('print', 'tool entitlement missing or revoked'), 'print_off');
  assert.equal(invoiceOutcomeFor('print', 'invoice changed since it was loaded'), 'failed');
});

test('only known outcome codes are shown from the URL', () => {
  assert.equal(isInvoiceOutcome('issued'), true);
  assert.equal(isInvoiceOutcome('<script>'), false);
  assert.equal(isInvoiceOutcome('toString'), false);
});

test('part letters and the current print outcome', () => {
  assert.equal(partLetter('ATL-0007A'), 'A'); assert.equal(partLetter('ATL-0007AB'), 'AB'); assert.equal(partLetter('ATL-0007'), null);
  const rows = [
    { outcome: 'failed' as const, actor_email: 'a', note: 'jammed', recorded_at: '2026-10-17T01:00:00Z' },
    { outcome: 'printed' as const, actor_email: 'a', note: null, recorded_at: '2026-10-17T01:05:00Z' },
  ];
  assert.equal(currentPrint(rows)?.outcome, 'printed'); assert.equal(currentPrint([]), null);
});
