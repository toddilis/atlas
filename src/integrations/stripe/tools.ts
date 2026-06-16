// Stripe write tools — Phase 1 PR-C. Only `stripe.create_invoice` is registered for now:
// it's the tool the outbox drainer calls after controller.issue_invoice has transitioned
// the canonical row to 'issued' (see migration 0012). It (a) creates the Stripe Invoice
// idempotently using our invoice UUID as the idempotency key, (b) writes the resulting
// stripe_invoice_id back onto the canonical row.
//
// The tool is mutating but its callable surface is the outbox drainer — no agent calls it
// directly — so we register it with defaultRisk='auto' and no policyInput extractor. The
// policy gate already fired at controller.issue_invoice; once that's allowed there's no
// second gate at the Stripe layer.

import { supabase, orgId } from '../../data/supabase.js';
import { registerTool, type ToolContext } from '../../platform/tools/registry.js';
import { stripe } from './client.js';

export interface CreateStripeInvoiceInput {
  /** Atlas canonical invoice id (uuid). Used as Stripe idempotency-key. */
  invoice_id: string;
  /** Atlas account uuid — resolved into Stripe customer id by lookup. */
  account_id: string;
  /** Invoice total in minor units. */
  total_cents: number;
  /** ISO-4217 code, lowercased for Stripe. */
  currency: string;
}

export interface CreateStripeInvoiceOutput {
  invoice_id: string;
  stripe_invoice_id: string;
  stripe_customer_id: string;
}

/**
 * Resolve our account uuid → Stripe customer id. Accounts hold a `stripe_customer_id`
 * column populated during onboarding; if it's missing we fail rather than auto-create,
 * because customer creation is a deliberate operator step (tax id, billing email, etc.).
 */
async function resolveStripeCustomer(accountId: string): Promise<string> {
  const sb = supabase();
  const { data, error } = await sb
    .from('accounts')
    .select('stripe_customer_id')
    .eq('org_id', orgId())
    .eq('id', accountId)
    .maybeSingle();
  if (error) throw error;
  if (!data?.stripe_customer_id) {
    throw new Error(
      `account ${accountId} has no stripe_customer_id — onboard the account in Stripe first`,
    );
  }
  return data.stripe_customer_id as string;
}

export async function execute(
  input: CreateStripeInvoiceInput,
  _ctx: ToolContext,
): Promise<CreateStripeInvoiceOutput> {
  const customerId = await resolveStripeCustomer(input.account_id);

  // Idempotency: our canonical invoice uuid. A re-drained outbox row will return the same
  // Stripe Invoice object instead of creating a duplicate.
  const stripeInvoice = await stripe().invoices.create(
    {
      customer: customerId,
      currency: input.currency.toLowerCase(),
      collection_method: 'send_invoice',
      days_until_due: 14,
      auto_advance: true,
      metadata: { atlas_invoice_id: input.invoice_id },
    },
    { idempotencyKey: `atlas:invoice:${input.invoice_id}` },
  );

  if (!stripeInvoice.id) {
    throw new Error('stripe returned an invoice with no id');
  }

  // Add a single line item summarising the total. PR-D will line-item per invoice_line
  // once the line schema is fully populated end-to-end; for now the total in one item is
  // sufficient and matches the wholesale ledger posting.
  await stripe().invoiceItems.create(
    {
      customer: customerId,
      invoice: stripeInvoice.id,
      amount: input.total_cents,
      currency: input.currency.toLowerCase(),
      description: `Atlas invoice ${input.invoice_id}`,
    },
    { idempotencyKey: `atlas:invoice:${input.invoice_id}:line` },
  );

  await stripe().invoices.finalizeInvoice(stripeInvoice.id, undefined, {
    idempotencyKey: `atlas:invoice:${input.invoice_id}:finalize`,
  });

  // Write the stripe_invoice_id back. The canonical invoice is already 'issued' — this
  // just stitches the Stripe pointer onto it.
  const sb = supabase();
  const { error } = await sb
    .from('invoices')
    .update({ stripe_invoice_id: stripeInvoice.id, updated_at: new Date().toISOString() })
    .eq('org_id', orgId())
    .eq('id', input.invoice_id);
  if (error) throw error;

  return {
    invoice_id: input.invoice_id,
    stripe_invoice_id: stripeInvoice.id,
    stripe_customer_id: customerId,
  };
}

let registered = false;

export function registerStripeTools(): void {
  if (registered) return;

  registerTool({
    name: 'stripe.create_invoice',
    defaultRisk: 'auto',
    mutating: true,
    execute,
  });

  registered = true;
}
