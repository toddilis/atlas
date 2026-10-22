// Invoice detail — lines, payments, and the ledger transaction(s) the issuance posted.
// Aggregates everything the operator needs to understand "what happened to this invoice".

import Link from 'next/link';
import { notFound } from 'next/navigation';
import { supabaseServer, orgId } from '@/lib/supabase';
import { formatCents, formatDate, formatDateTime } from '@/lib/format';
import { Badge, invoiceStateTone } from '@/components/Badge';
import { InvoicePart, type InvoicePartView } from '@/components/InvoicePart';
import { INVOICE_OUTCOMES, isInvoiceOutcome, type PrintOutcomeRow } from '@/lib/invoice-part';
import type { PricingSnapshot } from '../../../../src/platform/pricing/versioned';

export const dynamic = 'force-dynamic';

interface InvoiceDetail {
  id: string;
  invoice_number: string;
  state: string;
  channel: string;
  currency: string;
  subtotal_cents: number;
  tax_cents: number;
  total_cents: number;
  issued_at: string | null;
  due_at: string | null;
  paid_at: string | null;
  created_at: string;
  stripe_invoice_id: string | null;
  notes: string | null;
  fulfillment_event_id: string | null;
  account: { id: string; name: string } | null;
}

interface InvoiceLine {
  id: string;
  description: string;
  quantity: string | number;
  unit_price_cents: number;
  total_cents: number;
}

interface PaymentRow {
  id: string;
  amount_cents: number;
  currency: string;
  method: string;
  stripe_payment_id: string | null;
  reference: string | null;
  received_at: string;
}

interface LedgerLineRow {
  amount_cents: number;
  currency: string;
  memo: string | null;
  account: { code: string; display_name: string } | null;
}

interface LedgerTxnRow {
  id: string;
  source: string;
  description: string | null;
  occurred_at: string;
  posted_at: string;
  lines: LedgerLineRow[];
}

async function loadInvoice(id: string): Promise<{
  part: InvoicePartView | null;
  invoice: InvoiceDetail;
  lines: InvoiceLine[];
  payments: PaymentRow[];
  ledgerTxns: LedgerTxnRow[];
  canRecordPayment: boolean;
} | null> {
  const sb = await supabaseServer();
  const org = orgId();

  const { data: invoice, error: invErr } = await sb
    .from('invoices')
    .select(
      'id, invoice_number, state, channel, currency, subtotal_cents, tax_cents, total_cents, issued_at, due_at, paid_at, created_at, stripe_invoice_id, notes, fulfillment_event_id, account:accounts(id, name)',
    )
    .eq('org_id', org)
    .eq('id', id)
    .maybeSingle();
  if (invErr) throw invErr;
  if (!invoice) return null;

  const [linesRes, paymentsRes, ledgerRes, paymentGrant, paymentControls] = await Promise.all([
    sb
      .from('invoice_lines')
      .select('id, description, quantity, unit_price_cents, total_cents')
      .eq('org_id', org)
      .eq('invoice_id', id)
      .order('id'),
    sb
      .from('payments')
      .select('id, amount_cents, currency, method, stripe_payment_id, reference, received_at')
      .eq('org_id', org)
      .eq('invoice_id', id)
      .order('received_at', { ascending: false }),
    sb
      .from('ledger_transactions')
      .select(
        'id, source, description, occurred_at, posted_at, lines:ledger_lines(amount_cents, currency, memo, account:ledger_accounts(code, display_name))',
      )
      .eq('org_id', org)
      .eq('source_ref_type', 'invoice')
      .eq('source_ref', id)
      .order('occurred_at', { ascending: true }),
    sb.from('tool_grants').select('enabled').eq('org_id', org).eq('agent_name', 'operator').eq('tool_name', 'payments.record'),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
  ]);

  if (linesRes.error) throw linesRes.error;
  if (paymentsRes.error) throw paymentsRes.error;
  if (ledgerRes.error) throw ledgerRes.error;
  if (paymentGrant.error) throw paymentGrant.error;
  if (paymentControls.error) throw paymentControls.error;

  return {
    part: await loadPart(id, invoice as unknown as InvoiceDetail),
    invoice: (invoice as unknown) as InvoiceDetail,
    lines: ((linesRes.data as unknown) as InvoiceLine[]) ?? [],
    payments: ((paymentsRes.data as unknown) as PaymentRow[]) ?? [],
    ledgerTxns: ((ledgerRes.data as unknown) as LedgerTxnRow[]) ?? [],
    // Shown so the operator knows before trying; the database enforces the never-seeded
    // payments.record grant and pause on every entry (0043).
    canRecordPayment: (paymentGrant.data ?? []).some(g => g.enabled) && !paymentControls.data?.paused,
  };
}

/** A dispatch invoice part (0028) carries its immutable calculation and document; only those
 * are approved and printed from this page (0034). Null for any other invoice. */
async function loadPart(id: string, invoice: InvoiceDetail): Promise<InvoicePartView | null> {
  const sb = await supabaseServer();
  const org = orgId();
  const { data: snap, error } = await sb.from('invoice_calculation_snapshots')
    .select('snapshot, document, content_hash, pricing_version_id, dispatch_id').eq('org_id', org).eq('invoice_id', id).maybeSingle();
  if (error) throw error;
  if (!snap) return null;
  const [dispatch, version, grants, controls, prints, digest] = await Promise.all([
    sb.from('dispatches').select('source_dispatch_key').eq('org_id', org).eq('id', snap.dispatch_id).single(),
    sb.from('pricing_versions').select('version_key, revision').eq('org_id', org).eq('id', snap.pricing_version_id).single(),
    sb.from('tool_grants').select('tool_name, enabled').eq('org_id', org).eq('agent_name', 'operator').in('tool_name', ['controller.issue_invoice', 'invoices.record_print']),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
    sb.from('invoice_print_outcomes').select('outcome, actor_email, note, recorded_at').eq('org_id', org).eq('invoice_id', id),
    // The digest the approval binds: the exact snapshot this page shows.
    invoice.state === 'draft' ? sb.rpc('invoice_action_snapshot_digest', { p_org_id: org, p_invoice_id: id }) : Promise.resolve({ data: null, error: null }),
  ]);
  for (const r of [dispatch, version, grants, controls, prints, digest]) if (r.error) throw r.error;
  const granted = (tool: string) => (grants.data ?? []).some(g => g.tool_name === tool && g.enabled);
  const document = snap.document as { orderReference: string };
  return {
    invoiceId: id, invoiceNumber: invoice.invoice_number, state: invoice.state, snapshot: snap.snapshot as unknown as PricingSnapshot,
    orderReference: document.orderReference, dispatchKey: dispatch.data!.source_dispatch_key,
    pricingVersion: `${version.data!.version_key} (revision ${version.data!.revision})`, documentSha: snap.content_hash,
    snapshotSha: typeof digest.data === 'string' ? digest.data : null,
    canIssue: granted('controller.issue_invoice'), canRecordPrint: granted('invoices.record_print'),
    paused: Boolean(controls.data?.paused), prints: (prints.data ?? []) as PrintOutcomeRow[],
  };
}

export default async function InvoiceDetailPage({
  params, searchParams,
}: {
  params: Promise<{ id: string }>; searchParams: Promise<{ outcome?: string }>;
}) {
  const [{ id }, { outcome }] = await Promise.all([params, searchParams]);
  const result = await loadInvoice(id);
  if (!result) notFound();
  const { invoice, lines, payments, ledgerTxns, part, canRecordPayment } = result;
  // Only the fixed messages are shown from the URL; nothing from it is echoed.
  const notice = isInvoiceOutcome(outcome) ? INVOICE_OUTCOMES[outcome] : null;

  const paidToDate = payments.reduce((sum, p) => sum + Number(p.amount_cents), 0);
  const outstanding = Math.max(0, invoice.total_cents - paidToDate);

  return (
    <div className="space-y-8">
      <div>
        <Link
          href="/invoices"
          className="text-sm text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300"
        >
          ← All invoices
        </Link>
        <div className="mt-2 flex items-baseline justify-between gap-4 flex-wrap">
          <div>
            <h1 className="text-2xl font-semibold font-mono">{invoice.invoice_number}</h1>
            <div className="mt-1 text-zinc-600 dark:text-zinc-400">
              {invoice.account?.name ?? '—'} · {invoice.channel}
            </div>
          </div>
          <Badge tone={invoiceStateTone(invoice.state)}>{invoice.state}</Badge>
        </div>
      </div>

      {notice && (
        <p role="status" data-testid="invoice-notice" className={`p-3 border rounded text-sm ${notice.ok ? 'border-green-300 bg-green-50 text-green-900' : 'border-red-300 bg-red-50 text-red-900'}`}>
          {notice.text}
        </p>
      )}

      <SummaryGrid invoice={invoice} paidToDate={paidToDate} outstanding={outstanding} dueDate={part?.snapshot.terms.dueDate} />

      {part && <InvoicePart part={part} />}

      <Section title="Lines">
        {lines.length === 0 ? (
          <Empty>No lines on this invoice.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="text-left py-2 font-medium">Description</th>
                <th className="text-right py-2 font-medium">Qty</th>
                <th className="text-right py-2 font-medium">Unit</th>
                <th className="text-right py-2 font-medium">Total</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {lines.map((line) => (
                <tr key={line.id}>
                  <td className="py-2">{line.description}</td>
                  <td className="py-2 text-right font-mono">{line.quantity}</td>
                  <td className="py-2 text-right font-mono">
                    {formatCents(line.unit_price_cents, invoice.currency)}
                  </td>
                  <td className="py-2 text-right font-mono">
                    {formatCents(line.total_cents, invoice.currency)}
                  </td>
                </tr>
              ))}
              <tr className="text-xs text-zinc-500">
                <td colSpan={3} className="pt-3 text-right">Subtotal</td>
                <td className="pt-3 text-right font-mono">
                  {formatCents(invoice.subtotal_cents, invoice.currency)}
                </td>
              </tr>
              {invoice.tax_cents > 0 ? (
                <tr className="text-xs text-zinc-500">
                  <td colSpan={3} className="text-right">Tax</td>
                  <td className="text-right font-mono">
                    {formatCents(invoice.tax_cents, invoice.currency)}
                  </td>
                </tr>
              ) : null}
              <tr className="font-semibold">
                <td colSpan={3} className="pt-2 text-right">Total</td>
                <td className="pt-2 text-right font-mono">
                  {formatCents(invoice.total_cents, invoice.currency)}
                </td>
              </tr>
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Payments">
        {['issued', 'partial'].includes(invoice.state) ? (
          canRecordPayment ? (
            <form method="post" action={`/invoices/${invoice.id}/payment`}
              className="mb-4 flex flex-wrap items-end gap-2 rounded border border-zinc-200 dark:border-zinc-800 p-3">
              <label className="text-sm">Amount ({invoice.currency})<br />
                <input name="amount" aria-label="Payment amount" required inputMode="decimal" pattern="\d+(\.\d{1,2})?"
                  placeholder="0.00" className="rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm w-32 font-mono" /></label>
              <label className="text-sm">Received on<br />
                <input name="received_on" aria-label="Payment date" type="date" required
                  defaultValue={new Date().toISOString().slice(0, 10)}
                  className="rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm" /></label>
              <label className="text-sm">Bank reference<br />
                <input name="reference" aria-label="Payment reference" required minLength={3} maxLength={100}
                  placeholder="Statement line reference" className="rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm w-56" /></label>
              <button type="submit" className="rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-3 py-1 text-sm font-medium">
                Record payment
              </button>
              <span className="pb-1 text-xs text-zinc-500">Records the bank transfer and posts it; the same reference on this invoice is a retry, never a second payment.</span>
            </form>
          ) : (
            <div className="mb-4 text-xs text-zinc-500">
              Recording payments is switched off for this business (the operator payments.record grant is off, or actions are paused); a business turns it on deliberately.
            </div>
          )
        ) : null}
        {payments.length === 0 ? (
          <Empty>No payments received yet.</Empty>
        ) : (
          <table className="w-full text-sm">
            <thead className="text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="text-left py-2 font-medium">Received</th>
                <th className="text-left py-2 font-medium">Method</th>
                <th className="text-left py-2 font-medium">Reference</th>
                <th className="text-right py-2 font-medium">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-200 dark:divide-zinc-800">
              {payments.map((p) => (
                <tr key={p.id}>
                  <td className="py-2">{formatDateTime(p.received_at)}</td>
                  <td className="py-2">{p.method}</td>
                  <td className="py-2 font-mono text-xs text-zinc-500">
                    {p.reference ?? p.stripe_payment_id ?? '—'}
                  </td>
                  <td className="py-2 text-right font-mono">
                    {formatCents(p.amount_cents, p.currency)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Section>

      <Section title="Ledger">
        {ledgerTxns.length === 0 ? (
          <Empty>No ledger transactions posted for this invoice yet.</Empty>
        ) : (
          <div className="space-y-4">
            {ledgerTxns.map((txn) => (
              <LedgerCard key={txn.id} txn={txn} />
            ))}
          </div>
        )}
      </Section>
    </div>
  );
}

function SummaryGrid({
  invoice,
  paidToDate,
  outstanding,
  dueDate,
}: {
  invoice: InvoiceDetail;
  paidToDate: number;
  outstanding: number;
  /** An invoice part's own due date (its business's calendar day), not due_at in server time. */
  dueDate?: string;
}) {
  return (
    <div className="grid gap-3 grid-cols-2 md:grid-cols-4">
      <SummaryCell label="Total" value={formatCents(invoice.total_cents, invoice.currency)} />
      <SummaryCell label="Paid" value={formatCents(paidToDate, invoice.currency)} />
      <SummaryCell label="Outstanding" value={formatCents(outstanding, invoice.currency)} />
      <SummaryCell label="Issued" value={formatDate(invoice.issued_at)} />
      {dueDate ? (
        <SummaryCell label="Due" value={new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' }).format(Date.parse(`${dueDate}T00:00:00Z`))} />
      ) : invoice.due_at ? (
        <SummaryCell label="Due" value={formatDate(invoice.due_at)} />
      ) : null}
      {invoice.paid_at ? (
        <SummaryCell label="Paid at" value={formatDate(invoice.paid_at)} />
      ) : null}
      {invoice.stripe_invoice_id ? (
        <SummaryCell label="Stripe" value={invoice.stripe_invoice_id} mono />
      ) : null}
    </div>
  );
}

function SummaryCell({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="rounded border border-zinc-200 dark:border-zinc-800 px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-zinc-500">{label}</div>
      <div className={`mt-0.5 ${mono ? 'font-mono text-xs' : ''}`}>{value}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="text-sm font-semibold uppercase tracking-wide text-zinc-500 mb-2">
        {title}
      </h2>
      <div>{children}</div>
    </section>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return (
    <div className="rounded border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500">
      {children}
    </div>
  );
}

function LedgerCard({ txn }: { txn: LedgerTxnRow }) {
  return (
    <div className="rounded border border-zinc-200 dark:border-zinc-800 p-4">
      <div className="flex items-baseline justify-between gap-2 mb-2">
        <div className="text-sm font-medium">{txn.source}</div>
        <div className="text-xs text-zinc-500">{formatDateTime(txn.occurred_at)}</div>
      </div>
      {txn.description ? (
        <div className="text-sm text-zinc-600 dark:text-zinc-400 mb-2">{txn.description}</div>
      ) : null}
      <table className="w-full text-sm">
        <tbody>
          {txn.lines.map((line, i) => (
            <tr key={i} className="border-t border-zinc-100 dark:border-zinc-900 first:border-0">
              <td className="py-1.5 font-mono text-xs text-zinc-500">
                {line.account?.code ?? '—'}
              </td>
              <td className="py-1.5">{line.account?.display_name ?? '—'}</td>
              <td className="py-1.5 text-xs text-zinc-500">{line.memo ?? ''}</td>
              <td
                className={`py-1.5 text-right font-mono ${
                  line.amount_cents < 0 ? 'text-red-600 dark:text-red-400' : ''
                }`}
              >
                {formatCents(line.amount_cents, line.currency)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
