// controller.issue_invoice — the first money-moving tool routed through the policy engine.
//
// Contract:
//   input  → { invoiceId, amount, currency, accountId, fulfillmentEventId }
//   policy → PolicyInput { action='controller.issue_invoice', subjectType='invoice',
//                          subjectId=invoiceId, amount, currency,
//                          attributes={ account_id, fulfillment_event_id } }
//   handler → calls issue_invoice_atomic RPC (migration 0012) which, in one Postgres
//             transaction, (a) transitions draft→issued, (b) enqueues the
//             stripe.create_invoice outbox row, (c) posts the wholesale ledger entries.
//
// The caller (the Controller agent) loads the draft + lines and computes the total before
// dispatch, so the extractor stays pure (no I/O — see registry.ts:32-41).

import { supabase, orgId } from '../../../data/supabase.js';
import { appendEvent } from '../../../platform/events/eventLog.js';
import type { ToolContext } from '../../../platform/tools/registry.js';
import type { PolicyInput } from '../../../platform/policy/types.js';
import { invoiceApprovalSnapshot } from '../../../platform/control-plane/bound-actions.js';

export interface IssueInvoiceInput {
  invoiceId: string;
  amount: bigint;
  currency: string;
  accountId: string;
  fulfillmentEventId: string;
}

export interface IssueInvoiceOutput {
  invoiceId: string;
  state: 'issued';
  issuedAt: string;
  outboxId: string;
  ledgerTransactionId: string | null;
}

export function buildPolicyInput(
  input: IssueInvoiceInput,
  _ctx: ToolContext,
): Omit<PolicyInput, 'action'> {
  return {
    subjectType: 'invoice',
    subjectId: input.invoiceId,
    amount: input.amount,
    currency: input.currency,
    attributes: {
      account_id: input.accountId,
      fulfillment_event_id: input.fulfillmentEventId,
    },
  };
}

export async function approvalSnapshot(input: IssueInvoiceInput, ctx: ToolContext): Promise<Record<string, unknown>> {
  if (ctx.subjectType !== 'invoice' || ctx.subjectId !== input.invoiceId) throw new Error('invoice approval subject mismatch');
  const snapshot = await invoiceApprovalSnapshot(input.invoiceId);
  const invoice = snapshot.invoice as Record<string, unknown>;
  if (invoice.state !== 'draft' || String(invoice.total_cents) !== input.amount.toString() ||
      invoice.currency !== input.currency || invoice.account_id !== input.accountId ||
      invoice.fulfillment_event_id !== input.fulfillmentEventId)
    throw new Error('invoice amount, currency, account, fulfillment or state differs from proposal');
  return snapshot;
}

export async function execute(
  input: IssueInvoiceInput,
  ctx: ToolContext,
): Promise<IssueInvoiceOutput> {
  const sb = supabase();

  // Idempotency key for the Stripe-outbox enqueue. Re-running issue_invoice for the same
  // invoice in a recovery scenario gets dedup'd at the outbox layer.
  const outboxIdempotencyKey = `stripe.create_invoice:${input.invoiceId}`;

  const { data, error } = ctx.actionId && ctx.executionId ? await sb.rpc('issue_bound_invoice', {
    p_org_id: orgId(), p_action_id: ctx.actionId, p_execution_id: ctx.executionId,
  }) : await sb.rpc('issue_invoice_atomic', {
    p_org_id: orgId(),
    p_invoice_id: input.invoiceId,
    p_outbox_idempotency: outboxIdempotencyKey,
  });
  if (error) throw error;
  const row = (Array.isArray(data) ? data[0] : data) as {
    invoice_id: string; issued_at: string; outbox_id: string; ledger_transaction_id: string | null;
  } | null;
  if (!row) {
    throw new Error(
      `issue_invoice: rpc returned no rows for invoice ${input.invoiceId}`,
    );
  }

  await appendEvent({
    type: 'controller.invoice.issued',
    source: 'controller',
    agentName: 'controller',
    subjectType: 'invoice',
    subjectId: row.invoice_id as string,
    payload: {
      invoice_id: row.invoice_id,
      issued_at: row.issued_at,
      outbox_id: row.outbox_id,
      ledger_transaction_id: row.ledger_transaction_id,
      account_id: input.accountId,
      amount_cents: input.amount.toString(),
      currency: input.currency,
    },
    idempotencyKey: `controller.invoice.issued:${row.invoice_id}`,
  });

  return {
    invoiceId: row.invoice_id as string,
    state: 'issued',
    issuedAt: row.issued_at as string,
    outboxId: row.outbox_id as string,
    ledgerTransactionId: (row.ledger_transaction_id as string | null) ?? null,
  };
}
