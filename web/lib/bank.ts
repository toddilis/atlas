// Bank import (FLOW-01B, 0051): the interim CSV parser and the fixed outcome maps. The
// database owns the rules (grants, pause, identity, per-line validation, dedupe, the
// payment path and state transitions); this module parses the synthetic format exactly
// and maps refusals to fixed operator-facing outcomes — raw errors never reach the
// browser. The real Wise/ASB export becomes its own adapter when the sample arrives.

export const BANK_CSV_HEADER = 'date,amount,currency,description,reference,counterparty';

export interface ParsedBankLine {
  line_no: number; occurred_on: string; amount_cents: string; currency: string;
  description: string; reference: string; counterparty: string;
  raw: Record<string, string>;
}

/** Split one CSV record respecting RFC 4180 quotes. Returns null on a malformed field. */
function splitCsv(line: string): string[] | null {
  const out: string[] = []; let cur = ''; let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += c;
    } else if (c === '"') { if (cur !== '') return null; quoted = true; }
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  if (quoted) return null;
  out.push(cur);
  return out;
}

/** Signed exact cents from a decimal string: "-12.34" → "-1234". Null when invalid. */
export function parseSignedCents(value: string): string | null {
  const m = /^(-?)(\d{1,13})(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!m) return null;
  const cents = BigInt(m[2]) * 100n + BigInt((m[3] ?? '').padEnd(2, '0') || '0');
  if (cents === 0n) return null;
  return (m[1] === '-' ? -cents : cents).toString();
}

/** Parse the interim bank CSV. Either every row parses or the first problem is named by
 * line number — a partial import is never produced here. */
export function parseBankCsv(text: string): { lines: ParsedBankLine[] } | { error: string } {
  const rows = text.split(/\r?\n/).filter((row, i, all) => !(row === '' && i === all.length - 1));
  if (rows.length === 0 || rows[0].trim() !== BANK_CSV_HEADER) {
    return { error: `the first line must be exactly "${BANK_CSV_HEADER}"` };
  }
  if (rows.length === 1) return { error: 'the file has no bank lines' };
  if (rows.length - 1 > 2000) return { error: 'too many bank lines in one file (max 2000)' };
  const lines: ParsedBankLine[] = [];
  for (let i = 1; i < rows.length; i++) {
    const no = i; // 1-based data line number, matching what the operator sees
    if (rows[i].trim() === '') return { error: `line ${no}: empty row` };
    const fields = splitCsv(rows[i]);
    if (!fields || fields.length !== 6) return { error: `line ${no}: expected 6 fields` };
    const [date, amount, currency, description, reference, counterparty] = fields.map(f => f.trim());
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { error: `line ${no}: the date must be YYYY-MM-DD` };
    const cents = parseSignedCents(amount);
    if (cents === null) return { error: `line ${no}: the amount must be a non-zero decimal` };
    if (!/^[A-Za-z]{3}$/.test(currency)) return { error: `line ${no}: the currency must be a 3-letter code` };
    lines.push({
      line_no: no, occurred_on: date, amount_cents: cents, currency: currency.toUpperCase(),
      description, reference, counterparty,
      raw: { date, amount, currency, description, reference, counterparty },
    });
  }
  return { lines };
}

export const BANK_OUTCOMES = {
  imported: { ok: true, text: 'File imported. New lines were added; lines already imported were skipped, never doubled.' },
  line_matched: { ok: true, text: 'Payment recorded against the invoice through the exactly-once path, and the bank line marked matched.' },
  line_set_aside: { ok: true, text: 'Bank line set aside with its reason. It stays on record for the books; nothing was paid.' },
  line_reopened: { ok: true, text: 'Bank line reopened. It is unmatched again.' },
  invalid_file: { ok: false, text: 'The file could not be read. Nothing was imported.' },
  wrong_account: { ok: false, text: 'This exact file was already imported into a different bank account, or the account exists with a different currency. Nothing was imported.' },
  import_off: { ok: false, text: 'Importing bank lines is switched off for this business (its operator grant is missing, revoked, or set to require approval); a business turns it on deliberately. Nothing was imported.' },
  review_off: { ok: false, text: 'Reviewing bank lines is switched off for this business (its operator grant is missing or revoked). Nothing changed.' },
  match_failed: { ok: false, text: 'The payment was refused (check the invoice state, currency and what is outstanding), so nothing changed. The line stays unmatched.' },
  already_matched: { ok: false, text: 'This bank line is already matched to a payment. Nothing changed.' },
  not_credit: { ok: false, text: 'Only a credit line can match an invoice. Set a debit aside for the books instead.' },
  set_aside: { ok: false, text: 'This bank line is set aside. Reopen it first; nothing changed.' },
  reason_required: { ok: false, text: 'A set-aside reason is required (3–500 characters). Nothing changed.' },
  not_found: { ok: false, text: 'That bank line or invoice no longer exists for this business. Nothing changed.' },
  paused: { ok: false, text: 'Business actions are paused, so nothing changed. Resume them first.' },
  failed: { ok: false, text: 'The action could not be completed. Nothing changed; try again.' },
} as const;
export type BankOutcome = keyof typeof BANK_OUTCOMES;

const IMPORT_ERRORS: Array<[RegExp, BankOutcome]> = [
  [/tool entitlement missing or revoked|must not require approval|agent disabled/, 'import_off'],
  [/different bank account|different currency/, 'wrong_account'],
  [/bank line \d+:|no bank lines|too many bank lines|account name is required|account currency is required/, 'invalid_file'],
];
const MATCH_ERRORS: Array<[RegExp, BankOutcome]> = [
  [/bank line already matched/, 'already_matched'],
  [/only a credit bank line/, 'not_credit'],
  [/is set aside; reopen it/, 'set_aside'],
  [/not found/, 'not_found'],
  [/tool entitlement missing or revoked|must not require approval|agent disabled/, 'match_failed'],
  [/already fully paid|exceeds what is outstanding|void invoice|only an issued invoice|currency does not match|must not be in the future|conflicts with the stored payment/, 'match_failed'],
];
const REVIEW_ERRORS: Array<[RegExp, BankOutcome]> = [
  [/reason is required/, 'reason_required'],
  [/already set aside/, 'already_matched'],
  [/matched bank line cannot/, 'already_matched'],
  [/not found/, 'not_found'],
  [/tool entitlement missing or revoked|agent disabled/, 'review_off'],
];
export function bankOutcomeFor(action: 'import' | 'match' | 'review', message: string): BankOutcome {
  const table = action === 'import' ? IMPORT_ERRORS : action === 'match' ? MATCH_ERRORS : REVIEW_ERRORS;
  return [[/business actions paused/, 'paused'] as [RegExp, BankOutcome], ...table]
    .find(([pattern]) => pattern.test(message))?.[1] ?? 'failed';
}
export function isBankOutcome(value: unknown): value is BankOutcome {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(BANK_OUTCOMES, value);
}
