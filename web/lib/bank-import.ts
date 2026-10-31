// Bank statement import (FLOW-01B-a, 0051): turn one statement file into the rows the
// database stores, or name the first row it refuses. Pure and strict — the database
// re-checks every row and owns line identity and exactly-once storage; this module only
// parses, and maps refusals to fixed operator-facing outcomes (raw errors never reach
// the browser). Amounts stay exact: decimal text becomes integer cents through BigInt.

export const BANK_FILE_MAX_BYTES = 2_000_000;
export const BANK_FILE_MAX_ROWS = 5000;

/** The one layout until the Wise/ASB sample arrives; bank layouts become further formats. */
export const ATLAS_CSV_V1 = {
  required: ['date', 'amount', 'description'],
  optional: ['reference', 'counterparty', 'transaction_id', 'currency'],
} as const;

export interface BankLine {
  row: number; posted_on: string; amount_cents: string; description: string;
  reference: string | null; counterparty: string | null; transaction_id: string | null; currency: string | null;
  raw: Record<string, string>;
}

export const FILE_PROBLEMS = {
  empty: () => 'The file has no statement rows.',
  encoding: () => 'The file is not plain UTF-8 text.',
  quote: (row) => `Row ${row} has an unmatched or misplaced quote mark.`,
  header: (_row, column) => `The header row is missing the ${column ?? 'date, amount or description'} column. Required: date, amount and description; optional: reference, counterparty, transaction_id and currency.`,
  duplicate: (_row, column) => `The header row names the ${column ?? 'same'} column twice.`,
  columns: (row) => `Row ${row} has a different number of fields from the header row.`,
  date: (row) => `Row ${row}: the date must be a real date written YYYY-MM-DD, from 2000 onwards and not in the future.`,
  amount: (row) => `Row ${row}: the amount must be a signed number like -45.20, with no currency symbol or thousands separators.`,
  description: (row) => `Row ${row} has no description.`,
  field_long: (row) => `Row ${row} has a field that is too long.`,
  currency: (row) => `Row ${row} is in a different currency from the account.`,
  too_many: () => `The file has more than ${BANK_FILE_MAX_ROWS.toLocaleString('en-NZ')} rows. Export a shorter period.`,
  repeat: (row) => `Row ${row} repeats a bank transaction id that appears earlier in the file.`,
  mixed: () => 'Some rows have a transaction id and others do not. Export the statement in one layout.',
  conflict: (row) => `Row ${row} has the same bank transaction id as a stored line but different details; check the export.`,
  scheme: () => 'This file identifies lines differently from earlier imports for this account (with or without the bank’s transaction ids).',
  invalid: (row) => `Row ${row} could not be read. Check its date, amount and description.`,
} satisfies Record<string, (row: number | null, column?: string) => string>;
export type FileProblem = keyof typeof FILE_PROBLEMS;

export type ParseResult = { ok: true; lines: BankLine[] } | { ok: false; why: FileProblem; row: number | null; column?: string };

interface CsvRecord { row: number; fields: string[] }

/** RFC 4180 records with their 1-based row numbers (a quoted line break stays in its row). */
export function parseCsv(text: string): { ok: true; records: CsvRecord[] } | { ok: false; row: number } {
  const records: CsvRecord[] = [];
  let field = '', fields: string[] = [], quoted = false, wasQuoted = false, row = 1, i = 0;
  const endRecord = () => {
    fields.push(field);
    // A blank line is skipped, but it still counts as a row, like in a spreadsheet.
    if (!(fields.length === 1 && fields[0] === '' && !wasQuoted)) records.push({ row, fields });
    field = ''; fields = []; wasQuoted = false; row++;
  };
  while (i < text.length) {
    const c = text[i];
    if (quoted) {
      if (c !== '"') { field += c; i++; continue; }
      if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
      quoted = false; i++;
      const next = text[i];
      if (next !== undefined && next !== ',' && next !== '\n' && next !== '\r') return { ok: false, row };
      continue;
    }
    if (c === '"') {
      if (field !== '' || wasQuoted) return { ok: false, row };
      quoted = true; wasQuoted = true; i++; continue;
    }
    if (c === ',') { fields.push(field); field = ''; wasQuoted = false; i++; continue; }
    if (c === '\r' || c === '\n') { endRecord(); i += c === '\r' && text[i + 1] === '\n' ? 2 : 1; continue; }
    field += c; i++;
  }
  if (quoted) return { ok: false, row };
  if (field !== '' || fields.length > 0 || wasQuoted) endRecord();
  return { ok: true, records };
}

/** Exact signed cents from decimal text like -1250.5, or null. No floats, no separators. */
export function centsFromDecimal(input: string): string | null {
  const m = /^([+-])?(\d{1,13})(?:\.(\d{1,2}))?$/.exec(input.trim());
  if (!m) return null;
  const cents = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0'));
  return (m[1] === '-' && cents !== 0n ? -cents : cents).toString();
}

/** A real calendar date written YYYY-MM-DD, from 2000 to one day after today (UTC). */
export function statementDate(input: string, todayUtc: string): string | null {
  const s = input.trim();
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== s) return null;
  const latest = new Date(`${todayUtc}T00:00:00Z`);
  latest.setUTCDate(latest.getUTCDate() + 1);
  return s >= '2000-01-01' && s <= latest.toISOString().slice(0, 10) ? s : null;
}

const optional = (value: string | undefined, max: number): string | null | false => {
  const v = (value ?? '').trim();
  return v === '' ? null : v.length > max ? false : v;
};

/** Parse an atlas_csv_v1 statement for an account in `currency`. */
export function parseBankFile(text: string, currency: string, todayUtc: string): ParseResult {
  const body = text.startsWith('﻿') ? text.slice(1) : text;
  if (body.includes('\u0000')) return { ok: false, why: 'encoding', row: null };
  const csv = parseCsv(body);
  if (!csv.ok) return { ok: false, why: 'quote', row: csv.row };
  const [head, ...rows] = csv.records;
  if (!head) return { ok: false, why: 'empty', row: null };
  const names = head.fields.map(f => f.trim().toLowerCase());
  const named = names.filter(n => n !== '');
  if (new Set(named).size !== named.length) return { ok: false, why: 'duplicate', row: head.row, column: named.find((n, i) => named.indexOf(n) !== i) };
  const missing = ATLAS_CSV_V1.required.find(c => !names.includes(c));
  if (missing) return { ok: false, why: 'header', row: head.row, column: missing };
  if (rows.length === 0) return { ok: false, why: 'empty', row: null };
  if (rows.length > BANK_FILE_MAX_ROWS) return { ok: false, why: 'too_many', row: null };

  const lines: BankLine[] = [];
  for (const { row, fields } of rows) {
    if (fields.length !== names.length) return { ok: false, why: 'columns', row };
    const raw: Record<string, string> = {};
    names.forEach((n, i) => { if (n !== '') raw[n] = fields[i]; });
    if (Object.values(raw).some(v => v.length > 1000) || JSON.stringify(raw).length > 8000) return { ok: false, why: 'field_long', row };
    const postedOn = statementDate(raw.date, todayUtc);
    if (!postedOn) return { ok: false, why: 'date', row };
    const cents = centsFromDecimal(raw.amount);
    if (cents === null) return { ok: false, why: 'amount', row };
    const description = raw.description.trim();
    if (description === '') return { ok: false, why: 'description', row };
    const reference = optional(raw.reference, 200), counterparty = optional(raw.counterparty, 200);
    const transactionId = optional(raw.transaction_id, 100), lineCurrency = optional(raw.currency, 3);
    if (description.length > 500 || reference === false || counterparty === false || transactionId === false) return { ok: false, why: 'field_long', row };
    if (lineCurrency === false || (lineCurrency !== null && lineCurrency.toUpperCase() !== currency)) return { ok: false, why: 'currency', row };
    lines.push({ row, posted_on: postedOn, amount_cents: cents, description, reference, counterparty,
      transaction_id: transactionId, currency: lineCurrency?.toUpperCase() ?? null, raw });
  }
  return { ok: true, lines };
}

/** A statement date as a calendar day ("2 Oct 2026"), whatever the server's timezone. */
export function statementDay(d: string | null | undefined): string {
  return d ? new Intl.DateTimeFormat('en-NZ', { year: 'numeric', month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(`${d}T00:00:00Z`)) : '—';
}

/** A safe display name for the uploaded file: its base name, bounded. */
export function statementFileName(name: string): string {
  const base = name.split(/[\\/]/).pop()?.trim() ?? '';
  return (base === '' ? 'statement.csv' : base).slice(0, 255);
}

export const BANK_OUTCOMES = {
  account_saved: { ok: true, text: 'Bank account saved.' },
  imported: { ok: true, text: 'Statement imported.' },
  already_imported: { ok: true, text: 'This exact file was already imported for this account; nothing new was added.' },
  account_invalid: { ok: false, text: 'Enter a name, the bank, an account reference of at least two characters and a three-letter currency like NZD. Nothing changed.' },
  account_exists: { ok: false, text: 'This business already has that bank account (the same bank, reference and currency). Nothing changed.' },
  account_fixed: { ok: false, text: 'An account’s bank, reference and currency cannot change; a different account is a new account. Nothing changed.' },
  account_disabled: { ok: false, text: 'That account is disabled, so it takes no imports. Enable it first. Nothing was imported.' },
  stale: { ok: false, text: 'The account changed since the page was loaded. Nothing changed; reload and edit the current version.' },
  file_missing: { ok: false, text: 'Choose a CSV statement file to import. Nothing was imported.' },
  file_too_large: { ok: false, text: 'The file is larger than 2 MB. Export a shorter period. Nothing was imported.' },
  file_invalid: { ok: false, text: 'The file was refused. Nothing was imported.' },
  not_allowed: { ok: false, text: 'This is switched off for this business (its operator grant is missing or revoked). Nothing changed.' },
  paused: { ok: false, text: 'Business actions are paused, so nothing changed. Resume them first.' },
  not_found: { ok: false, text: 'That bank account no longer exists for this business. Nothing changed.' },
  failed: { ok: false, text: 'The change could not be saved. Nothing changed; try again.' },
  // Receipt matching (0052).
  allocated: { ok: true, text: 'Payment recorded from the bank line, exactly once.' },
  not_receipt: { ok: true, text: 'Bank line marked as not a customer receipt.' },
  reopened: { ok: true, text: 'Bank line reopened for matching.' },
  line_not_found: { ok: false, text: 'That bank line no longer exists for this business. Nothing changed.' },
  line_debit: { ok: false, text: 'Only money received can pay an invoice or be marked as not a receipt. Nothing changed.' },
  line_not_receipt: { ok: false, text: 'That line is marked as not a customer receipt; reopen it first. Nothing changed.' },
  line_exceeds: { ok: false, text: 'That is more than remains unapplied on the bank line. Nothing changed.' },
  line_allocated: { ok: false, text: 'That line already pays an invoice, so it cannot be marked as not a receipt. Nothing changed.' },
  pair_conflict: { ok: false, text: 'That bank line already pays that invoice a different amount. Nothing changed.' },
  currency_mismatch: { ok: false, text: 'The bank line and the invoice are in different currencies. Nothing changed.' },
  invoice_not_found: { ok: false, text: 'That invoice no longer exists for this business. Nothing changed.' },
  invoice_exceeds: { ok: false, text: 'That is more than the invoice has outstanding. Nothing changed.' },
  invoice_unpayable: { ok: false, text: 'That invoice cannot take a payment: it is paid, void or not yet issued. Nothing changed.' },
  amount_invalid: { ok: false, text: 'Enter a positive amount like 41.50. Nothing changed.' },
  reason_required: { ok: false, text: 'Give a reason of at least three characters. Nothing changed.' },
  already_marked: { ok: false, text: 'That line is already marked as not a customer receipt. Nothing changed.' },
  not_marked: { ok: false, text: 'That line is not marked as not a receipt, so there is nothing to reopen. Nothing changed.' },
} as const;
export type BankOutcome = keyof typeof BANK_OUTCOMES;
export interface BankResult { outcome: BankOutcome; row?: number | null; why?: FileProblem; column?: string }

const COMMON: Array<[RegExp, BankOutcome]> = [
  [/business actions paused/, 'paused'],
  [/tool entitlement missing or revoked|must not require approval|agent disabled/, 'not_allowed'],
  [/bank account not found/, 'not_found'],
];
const SAVE_ERRORS: Array<[RegExp, BankOutcome]> = [
  ...COMMON,
  [/already exists for this business/, 'account_exists'],
  [/are fixed/, 'account_fixed'],
  [/changed since it was loaded/, 'stale'],
  [/account name required|bank name required|account reference required|three-letter code|bank account fields required/, 'account_invalid'],
];

export function saveOutcomeFor(errorMessage: string): BankOutcome {
  return SAVE_ERRORS.find(([pattern]) => pattern.test(errorMessage))?.[1] ?? 'failed';
}

/** The database's import refusals, with the row it named where there is one. */
export function importOutcomeFor(errorMessage: string): BankResult {
  const common = COMMON.find(([pattern]) => pattern.test(errorMessage));
  if (common) return { outcome: common[1] };
  const row = Number(/bank row (\d+)/.exec(errorMessage)?.[1] ?? NaN);
  const at = Number.isSafeInteger(row) ? row : null;
  if (/bank account is disabled/.test(errorMessage)) return { outcome: 'account_disabled' };
  if (/conflicts with a stored line/.test(errorMessage)) return { outcome: 'file_invalid', why: 'conflict', row: at };
  if (/identifies lines differently/.test(errorMessage)) return { outcome: 'file_invalid', why: 'scheme' };
  if (/mixes rows with and without/.test(errorMessage)) return { outcome: 'file_invalid', why: 'mixed' };
  if (/repeats a transaction id/.test(errorMessage)) return { outcome: 'file_invalid', why: 'repeat', row: at };
  if (/different currency/.test(errorMessage)) return { outcome: 'file_invalid', why: 'currency', row: at };
  if (/bank row \d+ is invalid/.test(errorMessage)) return { outcome: 'file_invalid', why: 'invalid', row: at };
  if (/has no lines/.test(errorMessage)) return { outcome: 'file_invalid', why: 'empty' };
  if (/too many lines/.test(errorMessage)) return { outcome: 'file_invalid', why: 'too_many' };
  return { outcome: 'failed' };
}

const isOutcome = (v: unknown): v is BankOutcome => typeof v === 'string' && Object.prototype.hasOwnProperty.call(BANK_OUTCOMES, v);
const isProblem = (v: unknown): v is FileProblem => typeof v === 'string' && Object.prototype.hasOwnProperty.call(FILE_PROBLEMS, v);
const COLUMNS: readonly string[] = [...ATLAS_CSV_V1.required, ...ATLAS_CSV_V1.optional];

/** The page's query string after an action, rebuilt from fixed parts only. */
export function bankResultQuery(result: BankResult & { batch?: string; account?: string; allocation?: string }): string {
  const q = new URLSearchParams({ outcome: result.outcome });
  if (result.why) q.set('why', result.why);
  if (result.row != null) q.set('row', String(result.row));
  if (result.column) q.set('column', result.column);
  if (result.batch) q.set('batch', result.batch);
  if (result.account) q.set('account', result.account);
  if (result.allocation) q.set('allocation', result.allocation);
  return q.toString();
}

/** Read an outcome back from the query string; anything unrecognised shows nothing. */
export function readBankResult(params: Record<string, string | undefined>): BankResult | null {
  if (!isOutcome(params.outcome)) return null;
  const row = params.row && /^\d{1,7}$/.test(params.row) ? Number(params.row) : null;
  return {
    outcome: params.outcome, row,
    why: isProblem(params.why) ? params.why : undefined,
    column: params.column && COLUMNS.includes(params.column) ? params.column : undefined,
  };
}

/** The operator-facing text for a result; an import's counts come from its stored batch. */
export function bankNoticeText(result: BankResult): string {
  const base = BANK_OUTCOMES[result.outcome].text;
  if (result.outcome === 'file_invalid' && result.why) return `${FILE_PROBLEMS[result.why](result.row ?? null, result.column)} ${base}`;
  return base;
}
