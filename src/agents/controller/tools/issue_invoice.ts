// controller.issue_invoice — the first money-moving tool routed through the policy engine.
//
// Contract:
//   input  → { invoiceId, amount, currency, accountId, fulfillmentEventId }
//   policy → PolicyInput { action='controller.issue_invoice', subjectType='invoice',
//                          subjectId=invoiceId, amount, currency,
//                          attributes={ account_id, fulfillment_event_id } }
//   handler → transitions invoices(state='draft') → 'issued', sets issued_at.
//
// The caller (the Controller agent) loads the draft + lines and computes the total before
// dispatch, so the extractor stays pure (no I/O — see registry.ts:32-41). Stripe sync /
// outbox is deferred to PR-C; this PR sets `issued_at` only.

import { supabase, orgId } from '../../../data/supabase.js';
import type { ToolContext } from '../../../platform/tools/registry.js';
import type { PolicyInput } from '../../../platform/policy/types.js';

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

export async function execute(
  input: IssueInvoiceInput,
  _ctx: ToolContext,
): Promise<IssueInvoiceOutput> {
  const sb = supabase();
  const issuedAt = new Date().toISOString();

  // Conditional update guards against double-issuance: the WHERE clause requires
  // state='draft', so a concurrent issuer or a previously-issued row returns no rows.
  const { data, error } = await sb
    .from('invoices')
    .update({ state: 'issued', issued_at: issuedAt, updated_at: issuedAt })
    .eq('org_id', orgId())
    .eq('id', input.invoiceId)
    .eq('state', 'draft')
    .select('id, state, issued_at')
    .maybeSingle();
  if (error) throw error;
  if (!data) {
    throw new Error(
      `issue_invoice: no draft row to issue (invoice ${input.invoiceId} missing or not in draft)`,
    );
  }

  return {
    invoiceId: data.id as string,
    state: 'issued',
    issuedAt: data.issued_at as string,
  };
}
