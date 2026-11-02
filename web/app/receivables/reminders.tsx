// Payment reminders on the receivables page (CLOSE-01f, 0053): open drafts with their text
// to send, a form to record how each was sent, a form to void one, and the recent history.
// The text is rendered from the stored snapshot, so what is shown is exactly what was
// drafted; sending stays the operator's act.

import { formatCents, formatDateTime } from '@/lib/format';
import { REMINDER_CHANNELS, reminderText, type ReminderLine } from '@/lib/reminders';

export interface ReminderRow {
  id: string; account_id: string; currency: string; as_of_at: string; timezone: string; lines: ReminderLine[];
  overdue_cents: number; state: 'draft' | 'sent' | 'voided'; drafted_by: string; created_at: string;
  sent_at: string | null; sent_by: string | null; sent_channel: keyof typeof REMINDER_CHANNELS | null; sent_note: string | null;
  voided_at: string | null; voided_by: string | null; voided_reason: string | null; account: { name: string } | null;
}

const field = 'rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm';
const button = 'rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-3 py-1 text-sm font-medium';
const quiet = 'rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-sm';
const day = (isoDate: string) =>
  new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${isoDate}T00:00:00Z`));
const localDay = (iso: string, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(new Date(iso));

export function Reminders({ reminders, business, paymentInstructions, canSend, canVoid, note }: {
  reminders: ReminderRow[]; business: string; paymentInstructions: string | null; canSend: boolean; canVoid: boolean; note: string | null;
}) {
  const drafts = reminders.filter(r => r.state === 'draft');
  const history = reminders.filter(r => r.state !== 'draft');
  return (
    <section className="space-y-3" aria-label="Payment reminders">
      <h2 className="text-lg font-semibold">Payment reminders</h2>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-3xl">
        Draft a reminder from a late retailer&rsquo;s row above. Atlas writes it from the stored records as of that moment;
        you send it by email, print or phone, then record how. A draft that should not go can be voided.
      </p>
      {note ? <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm text-zinc-600 dark:text-zinc-400">{note}</div> : null}
      {drafts.length === 0 ? <div className="text-sm text-zinc-500" data-testid="reminders-empty">No draft reminders.</div> : drafts.map(r => {
        const retailer = r.account?.name ?? 'Retailer';
        const text = reminderText({ retailer, business, as_of_on: localDay(r.as_of_at, r.timezone), lines: r.lines,
          overdue_cents: r.overdue_cents, payment_instructions: paymentInstructions }, cents => formatCents(cents, r.currency), day);
        return (
          <div key={r.id} id={`reminder-${r.id}`} data-testid="reminder-draft" className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 space-y-3">
            <div className="flex flex-wrap items-baseline justify-between gap-2 text-sm">
              <span className="font-medium">{retailer} · {formatCents(r.overdue_cents, r.currency)} overdue</span>
              <span className="text-zinc-500">Drafted {formatDateTime(r.created_at)} by {r.drafted_by}</span>
            </div>
            <pre className="whitespace-pre-wrap rounded bg-zinc-50 dark:bg-zinc-900 p-3 text-sm font-mono">{text}</pre>
            <div className="flex flex-wrap items-end gap-4">
              {canSend ? (
                <form method="post" action="/receivables/reminders/sent" className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="reminder_id" value={r.id} />
                  <label className="text-xs text-zinc-500">Sent by<br />
                    <select name="channel" aria-label="Sent by" defaultValue="email" className={field}>
                      {Object.entries(REMINDER_CHANNELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                    </select></label>
                  <label className="text-xs text-zinc-500">Note (optional)<br />
                    <input name="note" aria-label="Send note" maxLength={500} placeholder="To accounts@" className={`${field} w-56`} /></label>
                  <button type="submit" className={button}>Record sent</button>
                </form>
              ) : null}
              {canVoid ? (
                <form method="post" action="/receivables/reminders/void" className="flex flex-wrap items-end gap-2">
                  <input type="hidden" name="reminder_id" value={r.id} />
                  <label className="text-xs text-zinc-500">Reason<br />
                    <input name="reason" aria-label="Void reason" required minLength={3} maxLength={500} placeholder="Paid in the meantime"
                      className={`${field} w-56`} /></label>
                  <button type="submit" className={quiet}>Void</button>
                </form>
              ) : null}
            </div>
          </div>
        );
      })}
      {history.length > 0 ? (
        <table className="w-full text-sm">
          <thead className="text-left text-zinc-500">
            <tr><th className="py-1">Retailer</th><th className="text-right">Overdue</th><th className="pl-6">Outcome</th><th>When</th><th>By</th></tr>
          </thead>
          <tbody className="divide-y divide-zinc-100 dark:divide-zinc-900">
            {history.map(r => (
              <tr key={r.id} id={`reminder-${r.id}`} data-testid="reminder-history">
                <td className="py-1">{r.account?.name ?? 'Retailer'}</td>
                <td className="text-right font-mono">{formatCents(r.overdue_cents, r.currency)}</td>
                <td className="pl-6">
                  {r.state === 'sent'
                    ? `Sent by ${r.sent_channel ? REMINDER_CHANNELS[r.sent_channel].toLowerCase() : '—'}${r.sent_note ? ` · ${r.sent_note}` : ''}`
                    : `Voided · ${r.voided_reason}`}
                </td>
                <td>{formatDateTime(r.state === 'sent' ? r.sent_at : r.voided_at)}</td>
                <td className="text-zinc-500">{r.state === 'sent' ? r.sent_by : r.voided_by}</td>
              </tr>
            ))}
          </tbody>
        </table>
      ) : null}
    </section>
  );
}
