// Payment reminders (CLOSE-01f, 0053): the text an operator sends a late retailer, rendered
// from the stored snapshot (which never changes), and the fixed outcome map. Pure. Atlas
// drafts; the operator sends it and records how.

export interface ReminderLine {
  invoice_id: string; invoice_number: string; aged_from: 'due' | 'issued'; anchor_on: string; days_late: number;
  outstanding_cents: string;
}
export interface ReminderView {
  retailer: string; business: string; as_of_on: string; lines: ReminderLine[]; overdue_cents: number | string;
  payment_instructions: string | null;
}

/** The reminder as text to paste into an email or print: every figure from the snapshot. */
export function reminderText(r: ReminderView, money: (cents: number) => string, day: (isoDate: string) => string): string {
  const rows = r.lines.map(l => `  ${l.invoice_number}  ${l.aged_from === 'due' ? 'due' : 'issued'} ${day(l.anchor_on)}  `
    + `${l.days_late} ${l.days_late === 1 ? 'day' : 'days'} late  ${money(Number(l.outstanding_cents))}`);
  return [
    `Hi ${r.retailer},`,
    '',
    `Our records show ${r.lines.length === 1 ? 'this invoice is' : 'these invoices are'} past due as of ${day(r.as_of_on)}:`,
    '',
    ...rows,
    '',
    `Total overdue: ${money(Number(r.overdue_cents))}`,
    '',
    ...(r.payment_instructions?.trim() ? ['Payment details:', r.payment_instructions.trim(), ''] : []),
    'If you have already paid, thank you, and please ignore this reminder. Otherwise please arrange payment, quoting the invoice numbers.',
    '',
    r.business,
  ].join('\n');
}

export const REMINDER_CHANNELS = { email: 'Email', print: 'Print', phone: 'Phone', other: 'Other' } as const;
export type ReminderChannel = keyof typeof REMINDER_CHANNELS;

export const REMINDER_OUTCOMES = {
  reminder_drafted: { ok: true, text: 'Reminder drafted from the stored records. Send it yourself, then record how you sent it.' },
  reminder_open: { ok: true, text: 'That retailer already has an open draft in this currency, shown below. Send or void it before drafting a newer one.' },
  reminder_sent: { ok: true, text: 'Reminder recorded as sent.' },
  reminder_voided: { ok: true, text: 'Reminder voided. Its snapshot is kept.' },
  nothing_overdue: { ok: false, text: 'Nothing is overdue for that retailer in that currency now. Nothing was drafted.' },
  channel_required: { ok: false, text: 'Choose how the reminder was sent. Nothing changed.' },
  reason_required: { ok: false, text: 'Give a reason of at least three characters to void a reminder. Nothing changed.' },
  already_sent: { ok: false, text: 'That reminder is already recorded as sent another way. Nothing changed.' },
  already_voided: { ok: false, text: 'That reminder is already voided. Nothing changed.' },
  sent_kept: { ok: false, text: 'A sent reminder went out and stays in the history; it cannot be voided. Nothing changed.' },
  not_found: { ok: false, text: 'That reminder or retailer no longer exists for this business. Nothing changed.' },
  not_allowed: { ok: false, text: 'This is switched off for this business (its operator grant is missing or revoked). Nothing changed.' },
  paused: { ok: false, text: 'Business actions are paused, so nothing changed. Resume them first.' },
  failed: { ok: false, text: 'The change could not be saved. Nothing changed; try again.' },
} as const;
export type ReminderOutcome = keyof typeof REMINDER_OUTCOMES;

const ERRORS: Array<[RegExp, ReminderOutcome]> = [
  [/business actions paused/, 'paused'],
  [/tool entitlement missing or revoked|must not require approval|agent disabled/, 'not_allowed'],
  [/nothing is overdue/, 'nothing_overdue'],
  [/channel required/, 'channel_required'],
  [/void reason required|void reason too long/, 'reason_required'],
  [/already recorded as sent/, 'already_sent'],
  [/already voided/, 'already_voided'],
  [/sent reminder cannot be voided/, 'sent_kept'],
  [/reminder not found|retailer not found/, 'not_found'],
];
export function reminderOutcomeFor(errorMessage: string): ReminderOutcome {
  return ERRORS.find(([pattern]) => pattern.test(errorMessage))?.[1] ?? 'failed';
}
export function isReminderOutcome(value: unknown): value is ReminderOutcome {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(REMINDER_OUTCOMES, value);
}
