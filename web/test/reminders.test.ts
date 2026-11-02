import assert from 'node:assert/strict';
import test from 'node:test';
import { reminderOutcomeFor, reminderText, type ReminderLine } from '../lib/reminders';

const money = (c: number) => `$${(c / 100).toFixed(2)}`;
const day = (d: string) => d;
const line = (over: Partial<ReminderLine>): ReminderLine => ({
  invoice_id: 'i', invoice_number: 'ATL-0001A', aged_from: 'due', anchor_on: '2026-09-20', days_late: 41, outstanding_cents: '31240', ...over,
});

test('the reminder text carries every figure from the snapshot (CLOSE-01f)', () => {
  const text = reminderText({
    retailer: 'Synthetic Export', business: 'VICE Sport Ltd', as_of_on: '2026-10-31', overdue_cents: 36240,
    lines: [line({}), line({ invoice_number: 'ATL-0007', aged_from: 'issued', anchor_on: '2026-10-30', days_late: 1, outstanding_cents: '5000' })],
    payment_instructions: 'ASB 12-3456-0001234-00, reference the invoice number',
  }, money, day);
  assert.equal(text, [
    'Hi Synthetic Export,',
    '',
    'Our records show these invoices are past due as of 2026-10-31:',
    '',
    '  ATL-0001A  due 2026-09-20  41 days late  $312.40',
    '  ATL-0007  issued 2026-10-30  1 day late  $50.00',
    '',
    'Total overdue: $362.40',
    '',
    'Payment details:',
    'ASB 12-3456-0001234-00, reference the invoice number',
    '',
    'If you have already paid, thank you, and please ignore this reminder. Otherwise please arrange payment, quoting the invoice numbers.',
    '',
    'VICE Sport Ltd',
  ].join('\n'));
});

test('one invoice reads in the singular, and no payment details means no empty block', () => {
  const text = reminderText({ retailer: 'R', business: 'B', as_of_on: '2026-10-31', overdue_cents: '31240', lines: [line({})], payment_instructions: '  ' }, money, day);
  assert.match(text, /this invoice is past due/);
  assert.doesNotMatch(text, /Payment details/);
});

test('database refusals map to fixed outcomes', () => {
  assert.equal(reminderOutcomeFor('business actions paused'), 'paused');
  assert.equal(reminderOutcomeFor('tool entitlement missing or revoked'), 'not_allowed');
  assert.equal(reminderOutcomeFor('nothing is overdue for this retailer in this currency'), 'nothing_overdue');
  assert.equal(reminderOutcomeFor('reminder channel required'), 'channel_required');
  assert.equal(reminderOutcomeFor('void reason required'), 'reason_required');
  assert.equal(reminderOutcomeFor('reminder already recorded as sent'), 'already_sent');
  assert.equal(reminderOutcomeFor('reminder already voided'), 'already_voided');
  assert.equal(reminderOutcomeFor('a sent reminder cannot be voided'), 'sent_kept');
  assert.equal(reminderOutcomeFor('reminder not found'), 'not_found');
  assert.equal(reminderOutcomeFor('retailer not found'), 'not_found');
  assert.equal(reminderOutcomeFor('timeout'), 'failed');
});
