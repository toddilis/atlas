import assert from 'node:assert/strict';
import test from 'node:test';
import {
  BANK_FILE_MAX_ROWS, bankNoticeText, bankResultQuery, centsFromDecimal, importOutcomeFor, parseBankFile, parseCsv,
  readBankResult, saveOutcomeFor, statementDate, statementFileName,
} from '../lib/bank-import';

const TODAY = '2026-10-31';

test('CSV records follow RFC 4180, with spreadsheet row numbers (FLOW-01B-a)', () => {
  const parsed = parseCsv('a,b\r\n"x, y","say ""hi"""\n"multi\nline",z\n\n1,2\n');
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.records, [
    { row: 1, fields: ['a', 'b'] },
    { row: 2, fields: ['x, y', 'say "hi"'] },
    { row: 3, fields: ['multi\nline', 'z'] },
    // The blank line is skipped but still counts, like a spreadsheet row.
    { row: 5, fields: ['1', '2'] },
  ]);
  assert.deepEqual(parseCsv('a,"",c').ok && parseCsv('a,"",c'), { ok: true, records: [{ row: 1, fields: ['a', '', 'c'] }] });
  assert.deepEqual(parseCsv('a,b\n"open,c\n'), { ok: false, row: 2 });
  assert.deepEqual(parseCsv('a,b\nx"y,c\n'), { ok: false, row: 2 });
  assert.deepEqual(parseCsv('a,b\n"x"y,c\n'), { ok: false, row: 2 });
});

test('amounts become exact signed cents, never floats, and nothing loose is accepted', () => {
  assert.equal(centsFromDecimal('141.50'), '14150');
  assert.equal(centsFromDecimal('-10'), '-1000');
  assert.equal(centsFromDecimal('+5.5'), '550');
  assert.equal(centsFromDecimal('0.05'), '5');
  assert.equal(centsFromDecimal('-0.00'), '0');
  assert.equal(centsFromDecimal(' 12 '), '1200');
  assert.equal(centsFromDecimal('9999999999999.99'), '999999999999999');
  for (const bad of ['1,250.00', '$5', '1.234', '', '-', '.5', '5.', '1e3', '12 34', '10000000000000']) {
    assert.equal(centsFromDecimal(bad), null, bad);
  }
});

test('statement dates are real calendar days, from 2000 to tomorrow', () => {
  assert.equal(statementDate('2026-10-02', TODAY), '2026-10-02');
  assert.equal(statementDate('2024-02-29', TODAY), '2024-02-29');
  assert.equal(statementDate('2026-11-01', TODAY), '2026-11-01');
  for (const bad of ['2026-02-30', '2026-13-01', '26-10-02', '2026-10-2', '02/10/2026', '1999-12-31', '2026-11-02']) {
    assert.equal(statementDate(bad, TODAY), null, bad);
  }
});

test('a statement file parses into rows, keeping every column of the source row', () => {
  const file = '\uFEFFDate,Amount,Description,Reference,Counterparty,Balance\r\n'
    + '2026-10-01,141.50,DIRECT CREDIT,ATL-0001,Synthetic Retail North,1141.50\r\n'
    + '2026-10-02,-10.00,"CARD 1234 COFFEE, ""TO GO""",,,1131.50\r\n';
  const parsed = parseBankFile(file, 'NZD', TODAY);
  assert.ok(parsed.ok);
  assert.deepEqual(parsed.lines[0], {
    row: 2, posted_on: '2026-10-01', amount_cents: '14150', description: 'DIRECT CREDIT', reference: 'ATL-0001',
    counterparty: 'Synthetic Retail North', transaction_id: null, currency: null,
    raw: { date: '2026-10-01', amount: '141.50', description: 'DIRECT CREDIT', reference: 'ATL-0001', counterparty: 'Synthetic Retail North', balance: '1141.50' },
  });
  assert.equal(parsed.lines[1].description, 'CARD 1234 COFFEE, "TO GO"');
  assert.equal(parsed.lines[1].reference, null);
  assert.equal(parsed.lines[1].amount_cents, '-1000');

  const withCurrency = parseBankFile('date,amount,description,currency,transaction_id\n2026-10-01,5,X,nzd,T-1\n', 'NZD', TODAY);
  assert.ok(withCurrency.ok);
  assert.equal(withCurrency.lines[0].currency, 'NZD');
  assert.equal(withCurrency.lines[0].transaction_id, 'T-1');
});

test('the first bad row refuses the whole file, by row number and reason', () => {
  const head = 'date,amount,description\n';
  const refuse = (text: string) => { const r = parseBankFile(text, 'NZD', TODAY); assert.ok(!r.ok); return { why: r.why, row: r.row, column: r.column }; };
  assert.deepEqual(refuse(''), { why: 'empty', row: null, column: undefined });
  assert.deepEqual(refuse(head), { why: 'empty', row: null, column: undefined });
  assert.deepEqual(refuse('date,amount\n2026-10-01,5\n'), { why: 'header', row: 1, column: 'description' });
  assert.deepEqual(refuse('date,amount,description,Amount\n'), { why: 'duplicate', row: 1, column: 'amount' });
  assert.deepEqual(refuse(head + '2026-10-01,5,OK\n2026-10-01,5\n'), { why: 'columns', row: 3, column: undefined });
  assert.deepEqual(refuse(head + '2026-10-01,5,OK\n2026-10-01,"-1,250.00",RENT\n'), { why: 'amount', row: 3, column: undefined });
  assert.deepEqual(refuse(head + '2026-02-30,5,OK\n'), { why: 'date', row: 2, column: undefined });
  assert.deepEqual(refuse(head + '2026-10-01,5,   \n'), { why: 'description', row: 2, column: undefined });
  assert.deepEqual(refuse('date,amount,description,currency\n2026-10-01,5,OK,USD\n'), { why: 'currency', row: 2, column: undefined });
  assert.deepEqual(refuse(head + `2026-10-01,5,${'x'.repeat(501)}\n`), { why: 'field_long', row: 2, column: undefined });
  assert.deepEqual(refuse(head + '2026-10-01,5,"unterminated\n'), { why: 'quote', row: 2, column: undefined });
  assert.deepEqual(refuse(head + '2026-10-01,5,NUL\u0000\n'), { why: 'encoding', row: null, column: undefined });
  assert.deepEqual(refuse(head + '2026-10-01,1,X\n'.repeat(BANK_FILE_MAX_ROWS + 1)), { why: 'too_many', row: null, column: undefined });
});

test('the uploaded file name is its bounded base name', () => {
  assert.equal(statementFileName('C:\\fakepath\\october.csv'), 'october.csv');
  assert.equal(statementFileName('/tmp/a/b.csv'), 'b.csv');
  assert.equal(statementFileName('  '), 'statement.csv');
  assert.equal(statementFileName('x'.repeat(300)).length, 255);
});

test('database refusals map to fixed outcomes, keeping only the row number', () => {
  assert.deepEqual(importOutcomeFor('business actions paused'), { outcome: 'paused' });
  assert.deepEqual(importOutcomeFor('tool entitlement missing or revoked'), { outcome: 'not_allowed' });
  assert.deepEqual(importOutcomeFor('importing a bank statement cannot itself require an approval; its grant must not require approval'), { outcome: 'not_allowed' });
  assert.deepEqual(importOutcomeFor('bank account not found'), { outcome: 'not_found' });
  assert.deepEqual(importOutcomeFor('bank account is disabled'), { outcome: 'account_disabled' });
  assert.deepEqual(importOutcomeFor('bank row 7 conflicts with a stored line'), { outcome: 'file_invalid', why: 'conflict', row: 7 });
  assert.deepEqual(importOutcomeFor('bank row 3 repeats a transaction id within the file'), { outcome: 'file_invalid', why: 'repeat', row: 3 });
  assert.deepEqual(importOutcomeFor('bank row 4 is in a different currency from its account'), { outcome: 'file_invalid', why: 'currency', row: 4 });
  assert.deepEqual(importOutcomeFor('bank row 9 is invalid'), { outcome: 'file_invalid', why: 'invalid', row: 9 });
  assert.deepEqual(importOutcomeFor('bank file mixes rows with and without a transaction id'), { outcome: 'file_invalid', why: 'mixed' });
  assert.deepEqual(importOutcomeFor('bank file identifies lines differently from earlier imports for this account'), { outcome: 'file_invalid', why: 'scheme' });
  assert.deepEqual(importOutcomeFor('connection reset'), { outcome: 'failed' });

  assert.equal(saveOutcomeFor('this bank account already exists for this business'), 'account_exists');
  assert.equal(saveOutcomeFor("a bank account's bank, reference and currency are fixed"), 'account_fixed');
  assert.equal(saveOutcomeFor('bank account changed since it was loaded'), 'stale');
  assert.equal(saveOutcomeFor('bank account currency must be a three-letter code'), 'account_invalid');
  assert.equal(saveOutcomeFor('bank account not found'), 'not_found');
  assert.equal(saveOutcomeFor('something else'), 'failed');
});

test('the result round-trips through the query string, and only fixed parts are read back', () => {
  const query = bankResultQuery({ outcome: 'file_invalid', why: 'amount', row: 3, account: '86000000-0000-4000-8000-000000000001' });
  const read = readBankResult(Object.fromEntries(new URLSearchParams(query)));
  assert.deepEqual(read, { outcome: 'file_invalid', why: 'amount', row: 3, column: undefined });
  assert.equal(bankNoticeText(read!), 'Row 3: the amount must be a signed number like -45.20, with no currency symbol or thousands separators. The file was refused. Nothing was imported.');
  assert.equal(bankNoticeText({ outcome: 'file_invalid', why: 'header', row: 1, column: 'amount' }).startsWith('The header row is missing the amount column.'), true);

  assert.equal(readBankResult({ outcome: '<script>' }), null);
  assert.deepEqual(readBankResult({ outcome: 'file_invalid', why: 'nonsense', row: '3; drop', column: 'evil' }),
    { outcome: 'file_invalid', why: undefined, row: null, column: undefined });
  assert.equal(bankNoticeText({ outcome: 'account_saved' }), 'Bank account saved.');
});
