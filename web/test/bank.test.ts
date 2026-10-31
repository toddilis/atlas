import assert from 'node:assert/strict';
import test from 'node:test';
import { BANK_CSV_HEADER, BANK_OUTCOMES, bankOutcomeFor, isBankOutcome, parseBankCsv, parseSignedCents } from '../lib/bank';

test('signed exact cents from decimals, zero and junk refused (0051)', () => {
  assert.equal(parseSignedCents('100'), '10000');
  assert.equal(parseSignedCents('241.5'), '24150');
  assert.equal(parseSignedCents('-12.34'), '-1234');
  assert.equal(parseSignedCents('0'), null);
  assert.equal(parseSignedCents('0.00'), null);
  assert.equal(parseSignedCents('1,000'), null);
  assert.equal(parseSignedCents('1e3'), null);
  assert.equal(parseSignedCents('--5'), null);
});

test('the interim CSV parses whole or names the first bad line', () => {
  const ok = parseBankCsv(`${BANK_CSV_HEADER}\n2026-10-02,100.00,NZD,"Transfer, October",INV-1,Payer A\n2026-10-03,-12.34,nzd,Fee,,\n`);
  assert.ok('lines' in ok);
  if ('lines' in ok) {
    assert.equal(ok.lines.length, 2);
    assert.deepEqual(ok.lines[0], {
      line_no: 1, occurred_on: '2026-10-02', amount_cents: '10000', currency: 'NZD',
      description: 'Transfer, October', reference: 'INV-1', counterparty: 'Payer A',
      raw: { date: '2026-10-02', amount: '100.00', currency: 'NZD', description: 'Transfer, October', reference: 'INV-1', counterparty: 'Payer A' },
    });
    assert.equal(ok.lines[1].amount_cents, '-1234');
    assert.equal(ok.lines[1].currency, 'NZD');
  }
  assert.deepEqual(parseBankCsv('date,amount\n1,2'), { error: `the first line must be exactly "${BANK_CSV_HEADER}"` });
  assert.deepEqual(parseBankCsv(`${BANK_CSV_HEADER}\n`), { error: 'the file has no bank lines' });
  assert.deepEqual(parseBankCsv(`${BANK_CSV_HEADER}\n2026-10-02,100,NZD,x,y`), { error: 'line 1: expected 6 fields' });
  assert.deepEqual(parseBankCsv(`${BANK_CSV_HEADER}\nnot-a-date,100,NZD,x,y,z`), { error: 'line 1: the date must be YYYY-MM-DD' });
  assert.deepEqual(parseBankCsv(`${BANK_CSV_HEADER}\n2026-10-02,0,NZD,x,y,z`), { error: 'line 1: the amount must be a non-zero decimal' });
  assert.deepEqual(parseBankCsv(`${BANK_CSV_HEADER}\n2026-10-02,1,NZ,x,y,z`), { error: 'line 1: the currency must be a 3-letter code' });
  assert.deepEqual(parseBankCsv(`${BANK_CSV_HEADER}\n2026-10-02,1,NZD,"unterminated,y,z`), { error: 'line 1: expected 6 fields' });
});

test('bank refusals map to fixed outcomes per action', () => {
  assert.equal(bankOutcomeFor('import', 'tool entitlement missing or revoked'), 'import_off');
  assert.equal(bankOutcomeFor('import', 'importing bank lines cannot itself require an approval; its grant must not require approval'), 'import_off');
  assert.equal(bankOutcomeFor('import', 'bank line 7: currency does not match the account'), 'invalid_file');
  assert.equal(bankOutcomeFor('import', 'this file was already imported into a different bank account'), 'wrong_account');
  assert.equal(bankOutcomeFor('import', 'this bank account already exists with a different currency'), 'wrong_account');
  assert.equal(bankOutcomeFor('match', 'bank line already matched'), 'already_matched');
  assert.equal(bankOutcomeFor('match', 'only a credit bank line can match an invoice'), 'not_credit');
  assert.equal(bankOutcomeFor('match', 'this bank line is set aside; reopen it first'), 'set_aside');
  assert.equal(bankOutcomeFor('match', 'payment exceeds what is outstanding on this invoice'), 'match_failed');
  assert.equal(bankOutcomeFor('match', 'this invoice is already fully paid; an overpayment or refund is an explicit correction, not a payment entry'), 'match_failed');
  assert.equal(bankOutcomeFor('match', 'tool entitlement missing or revoked'), 'match_failed');
  assert.equal(bankOutcomeFor('match', 'invoice not found'), 'not_found');
  assert.equal(bankOutcomeFor('review', 'a set-aside reason is required'), 'reason_required');
  assert.equal(bankOutcomeFor('review', 'a matched bank line cannot be set aside'), 'already_matched');
  assert.equal(bankOutcomeFor('review', 'tool entitlement missing or revoked'), 'review_off');
  for (const action of ['import', 'match', 'review'] as const) {
    assert.equal(bankOutcomeFor(action, 'business actions paused'), 'paused');
    assert.equal(bankOutcomeFor(action, 'socket hang up'), 'failed');
  }
  for (const key of Object.keys(BANK_OUTCOMES)) assert.equal(isBankOutcome(key), true, key);
  assert.equal(isBankOutcome('x'), false);
});
