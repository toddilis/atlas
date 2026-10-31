// Receipt matching (FLOW-01B-b, 0052): which invoice a customer receipt in the bank source
// most likely pays. Pure and deterministic, and only ever a proposal: the operator confirms
// each payment, and the database re-checks the line's remainder, the invoice's outstanding
// amount, the currency and the invoice's state when it records it. A matching amount
// alone makes a candidate that says so, never a quiet match.

import type { BankOutcome } from './bank-import';

export interface OpenInvoice { id: string; invoice_number: string; currency: string; outstanding_cents: number }
export interface ReceiptLine {
  amount_cents: number; currency: string; reference: string | null; description: string;
  allocated_cents: number; not_receipt: boolean;
}
export interface Allocation { invoice: OpenInvoice; amount_cents: number }

export type Match =
  | { kind: 'debit' | 'not_receipt' | 'settled' | 'unmatched' }
  | { kind: 'exact' | 'split' | 'partial' | 'amount_only'; allocations: Allocation[] }
  | { kind: 'excess'; allocations: Allocation[]; leftover_cents: number }
  | { kind: 'ambiguous'; candidates: OpenInvoice[] };

/** Whether text names the invoice number: its letter/digit runs in order, separated by at
 * most three other characters, and not inside a longer code (ATL-0001 is not ATL-0001A). */
export function namesInvoice(text: string, invoiceNumber: string): boolean {
  const runs = invoiceNumber.toUpperCase().match(/[A-Z0-9]+/g) ?? [];
  if (runs.join('').length < 4) return false;
  return new RegExp(`(?<![A-Z0-9])${runs.join('[^A-Z0-9]{0,3}')}(?![A-Z0-9])`, 'i').test(text);
}

export function classifyReceipt(line: ReceiptLine, open: OpenInvoice[]): Match {
  if (line.amount_cents <= 0) return { kind: 'debit' };
  if (line.not_receipt) return { kind: 'not_receipt' };
  const remaining = line.amount_cents - line.allocated_cents;
  if (remaining <= 0) return { kind: 'settled' };
  const payable = open.filter(i => i.currency === line.currency && i.outstanding_cents > 0);
  const text = `${line.reference ?? ''} ${line.description}`;
  const named = payable.filter(i => namesInvoice(text, i.invoice_number));
  if (named.length === 1) {
    const [invoice] = named;
    if (remaining === invoice.outstanding_cents) return { kind: 'exact', allocations: [{ invoice, amount_cents: remaining }] };
    if (remaining < invoice.outstanding_cents) return { kind: 'partial', allocations: [{ invoice, amount_cents: remaining }] };
    return { kind: 'excess', allocations: [{ invoice, amount_cents: invoice.outstanding_cents }], leftover_cents: remaining - invoice.outstanding_cents };
  }
  if (named.length > 1) {
    const total = named.reduce((n, i) => n + i.outstanding_cents, 0);
    return total === remaining
      ? { kind: 'split', allocations: named.map(invoice => ({ invoice, amount_cents: invoice.outstanding_cents })) }
      : { kind: 'ambiguous', candidates: named };
  }
  const sameAmount = payable.filter(i => i.outstanding_cents === remaining);
  if (sameAmount.length === 1) return { kind: 'amount_only', allocations: [{ invoice: sameAmount[0], amount_cents: remaining }] };
  if (sameAmount.length > 1) return { kind: 'ambiguous', candidates: sameAmount };
  return { kind: 'unmatched' };
}

/** One sentence for the operator, naming the evidence behind the proposal. */
export function matchSummary(match: Match, money: (cents: number) => string): string {
  const list = (invoices: OpenInvoice[]) => invoices.map(i => i.invoice_number).join(', ');
  switch (match.kind) {
    case 'exact': return `Pays ${match.allocations[0].invoice.invoice_number} in full; the invoice is named in the bank reference.`;
    case 'split': return `Pays ${list(match.allocations.map(a => a.invoice))} in full; each is named in the bank reference.`;
    case 'partial': {
      const [a] = match.allocations;
      return `Part-pays ${a.invoice.invoice_number}: ${money(a.amount_cents)} of ${money(a.invoice.outstanding_cents)} outstanding.`;
    }
    case 'excess': {
      const [a] = match.allocations;
      return `Pays ${a.invoice.invoice_number} in full (${money(a.amount_cents)}) and leaves ${money(match.leftover_cents)} unexplained.`;
    }
    case 'amount_only': return `Same amount as ${match.allocations[0].invoice.invoice_number} has outstanding, but the bank reference does not name it. Confirm only if you know it pays this invoice.`;
    case 'ambiguous': return `Could pay ${list(match.candidates)}. Choose the invoice below.`;
    case 'unmatched': return 'No open invoice is named in the reference or has this amount outstanding.';
    case 'debit': return 'Money paid out: for the books, not a receipt.';
    case 'not_receipt': return 'Marked as not a customer receipt.';
    case 'settled': return 'Fully applied to invoices.';
  }
}

const COMMON: Array<[RegExp, BankOutcome]> = [
  [/business actions paused/, 'paused'],
  [/tool entitlement missing or revoked|must not require approval|agent disabled/, 'not_allowed'],
  [/bank line not found/, 'line_not_found'],
];

const ALLOCATE_ERRORS: Array<[RegExp, BankOutcome]> = [
  ...COMMON,
  [/only a credit bank line can pay/, 'line_debit'],
  [/is marked as not a receipt/, 'line_not_receipt'],
  [/exceeds what remains on this bank line/, 'line_exceeds'],
  [/already pays this invoice a different amount/, 'pair_conflict'],
  [/different currencies/, 'currency_mismatch'],
  [/invoice not found/, 'invoice_not_found'],
  [/exceeds what is outstanding/, 'invoice_exceeds'],
  [/already fully paid|void invoice cannot|only an issued invoice/, 'invoice_unpayable'],
  [/amount must be positive/, 'amount_invalid'],
];

const REVIEW_ERRORS: Array<[RegExp, BankOutcome]> = [
  ...COMMON,
  [/reason is required/, 'reason_required'],
  [/already pays an invoice/, 'line_allocated'],
  [/only a credit bank line can be marked/, 'line_debit'],
  [/already marked as not a receipt/, 'already_marked'],
  [/is not marked as not a receipt/, 'not_marked'],
];

export const allocateOutcomeFor = (message: string): BankOutcome =>
  ALLOCATE_ERRORS.find(([pattern]) => pattern.test(message))?.[1] ?? 'failed';
export const reviewOutcomeFor = (message: string): BankOutcome =>
  REVIEW_ERRORS.find(([pattern]) => pattern.test(message))?.[1] ?? 'failed';
