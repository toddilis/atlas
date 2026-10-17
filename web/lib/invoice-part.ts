// Invoice part view model (FLOW-01A, step 4b). Pure: the fixed messages for approving an
// invoice part and recording its print, and how database refusals map to them.

export const INVOICE_OUTCOMES = {
  issued: { ok: true, text: 'Invoice approved and issued exactly as shown. Print it below; issuing does not deliver it.' },
  printed: { ok: true, text: 'Recorded as printed, against this exact document.' },
  print_failed: { ok: true, text: 'Recorded that printing failed. Print it again and record the outcome when it works.' },
  changed: { ok: false, text: 'This invoice changed after the page loaded, so nothing was issued. Check it again below.' },
  not_draft: { ok: false, text: 'This invoice is no longer a draft, so nothing was issued.' },
  not_part: { ok: false, text: 'Only invoice parts drafted from a dispatch can be approved here. Nothing was issued.' },
  issue_off: { ok: false, text: 'Invoice issuing is switched off for this business (its operator grant is missing or revoked). Nothing was issued.' },
  policy: { ok: false, text: 'The issuing policy (amount or volume limits) refuses this invoice now. Nothing was issued.' },
  ledger: { ok: false, text: 'This business has no chart of accounts to post the invoice to, so nothing was issued. It is set up during onboarding.' },
  print_off: { ok: false, text: 'Recording print outcomes is switched off for this business (its operator grant is missing or revoked). Nothing was recorded.' },
  not_issued: { ok: false, text: 'Only an issued invoice can be printed. Approve it first; nothing was recorded.' },
  document_changed: { ok: false, text: 'The stored document is not the one this page showed, so nothing was recorded. Reload and check it.' },
  note: { ok: false, text: 'Say briefly what went wrong (at least 3 characters). Nothing was recorded.' },
  paused: { ok: false, text: 'Business actions are paused, so nothing changed. Resume them first.' },
  failed: { ok: false, text: 'The action could not be recorded. Nothing changed; try again.' },
} as const;
export type InvoiceOutcome = keyof typeof INVOICE_OUTCOMES;
export const isInvoiceOutcome = (value: unknown): value is InvoiceOutcome =>
  typeof value === 'string' && Object.prototype.hasOwnProperty.call(INVOICE_OUTCOMES, value);

const COMMON: Array<[RegExp, InvoiceOutcome]> = [
  [/business actions paused/, 'paused'],
];
const APPROVE: Array<[RegExp, InvoiceOutcome]> = [
  [/changed since it was loaded|invoice changed|invoice snapshot changed/, 'changed'],
  [/not a draft/, 'not_draft'],
  [/only invoice parts drafted from a dispatch/, 'not_part'],
  [/tool entitlement missing or revoked|agent disabled/, 'issue_off'],
  [/policy|cap blocks|velocity limit/, 'policy'],
  [/chart of accounts/, 'ledger'],
];
const PRINT: Array<[RegExp, InvoiceOutcome]> = [
  [/say what went wrong/, 'note'],
  [/only an issued invoice/, 'not_issued'],
  [/document changed|no stored document/, 'document_changed'],
  [/tool entitlement missing or revoked|agent disabled/, 'print_off'],
];
export function invoiceOutcomeFor(action: 'approve' | 'print', message: string): InvoiceOutcome {
  return [...COMMON, ...(action === 'approve' ? APPROVE : PRINT)].find(([p]) => p.test(message))?.[1] ?? 'failed';
}

/** The part suffix of an invoice number (A, B, …, Z, AA …), or null for an unsuffixed one. */
export const partLetter = (invoiceNumber: string) => /[A-Z]+$/.exec(invoiceNumber)?.[0] ?? null;

export interface PrintOutcomeRow { outcome: 'printed' | 'failed'; actor_email: string; note: string | null; recorded_at: string }
/** The latest outcome is the current one; earlier rows stay as history. */
export function currentPrint(rows: PrintOutcomeRow[]): PrintOutcomeRow | null {
  return [...rows].sort((a, b) => b.recorded_at.localeCompare(a.recorded_at))[0] ?? null;
}
