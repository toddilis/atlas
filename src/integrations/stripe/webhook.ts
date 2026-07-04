// Stripe webhook handler — Phase 1 PR-C. Stripe POSTs to /webhooks/stripe; we verify the
// signature, append the raw event to event_log (idempotent on stripe event id), and let a
// projector turn the event into canonical state (payments row + invoice transition +
// ledger posting via the post_payment_received RPC).
//
// Flow for `invoice.paid`:
//   raw POST → verify sig → appendEvent('stripe.invoice.paid', idempotencyKey=stripe.<evt_id>)
//   → projector: rpc record_stripe_payment (0018 — resolves the invoice, inserts-or-adopts
//     the payment, posts the ledger + invoice transition, all in ONE transaction; stranded
//     pre-0018 payments are completed on the way through) → emit controller.payment.recorded
//
// Other Stripe event types are accepted but skipped (a future PR adds handlers without
// changing the signature-verification path).

import type Stripe from 'stripe';
import { supabase, orgId } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';
import { appendEvent } from '../../platform/events/eventLog.js';
import { registerProjector } from '../../platform/events/projector.js';
import { log } from '../../platform/log.js';
import { stripe, webhookSecret } from './client.js';

export interface StripeWebhookResult {
  ok: boolean;
  status: number;
  message: string;
  eventId?: string;
}

/**
 * Process a Stripe webhook delivery. Returns the HTTP response shape the API layer should
 * send back to Stripe — non-2xx triggers a retry from Stripe, which is what we want for
 * transient failures (DB unavailable etc.).
 */
export async function handleStripeWebhook(
  rawBody: Buffer | string,
  headers: Record<string, string | undefined>,
): Promise<StripeWebhookResult> {
  const signature =
    headers['stripe-signature'] ?? headers['Stripe-Signature'];
  if (!signature) {
    return { ok: false, status: 400, message: 'missing stripe-signature header' };
  }

  let event: Stripe.Event;
  try {
    event = stripe().webhooks.constructEvent(rawBody, signature, webhookSecret());
  } catch (e) {
    log.warn('stripe.webhook.signature_invalid', { error: (e as Error).message });
    return { ok: false, status: 401, message: 'invalid signature' };
  }

  // Only `invoice.paid` is wired in this PR; other types are durably logged via
  // idempotency_key but not projected.
  if (event.type !== 'invoice.paid') {
    log.info('stripe.webhook.unhandled_type', { type: event.type, id: event.id });
    return { ok: true, status: 200, message: 'received (unhandled type)' };
  }

  const appended = await appendEvent({
    type: 'stripe.invoice.paid',
    source: 'stripe_webhook',
    subjectType: 'invoice',
    subjectId: null,                          // canonical id resolved by the projector
    payload: event as unknown as Record<string, unknown>,
    occurredAt: new Date(event.created * 1000),
    idempotencyKey: `stripe.${event.id}`,
  });

  if (!appended.projected) {
    // The append is durable; the projection failed and was recorded (0017). Non-2xx makes
    // Stripe redeliver — the dedup path re-dispatches unprojected events — and the replay
    // loop is the backstop once redeliveries run out.
    return { ok: false, status: 500, message: 'event stored; projection pending retry', eventId: appended.id };
  }

  return { ok: true, status: 200, message: 'accepted', eventId: appended.id };
}

// ---------- projector ----------

async function projectStripeInvoicePaid(event: {
  payload: Record<string, unknown>;
}): Promise<void> {
  const sb = supabase();
  const stripeEvent = event.payload as unknown as Stripe.Event;
  const stripeInvoice = stripeEvent.data.object as Stripe.Invoice;

  const stripeInvoiceId = stripeInvoice.id;
  if (!stripeInvoiceId) {
    throw new Error('stripe.invoice.paid event has no invoice id');
  }

  // The Stripe Invoice carries `amount_paid` (minor units) for the cumulative paid amount.
  // For a typical send_invoice flow with one charge this equals total. We record one
  // payments row per webhook event, keyed for idempotency by the Stripe webhook event id
  // (every delivery — including re-sends — carries the same id). When the invoice carries
  // an InvoicePayment with a concrete payment_intent / charge / payment_record, we record
  // that as the human-meaningful pointer in `raw.payment_ref`; the unique index dedup is
  // still driven by stripe_payment_id = the event id.
  const stripePaymentId = `stripe_event:${stripeEvent.id}`;
  const firstPayment = stripeInvoice.payments?.data?.[0]?.payment;
  const paymentRef =
    firstPayment?.type === 'payment_intent'
      ? typeof firstPayment.payment_intent === 'string'
        ? firstPayment.payment_intent
        : firstPayment.payment_intent?.id
      : firstPayment?.type === 'charge'
        ? typeof firstPayment.charge === 'string'
          ? firstPayment.charge
          : firstPayment.charge?.id
        : firstPayment?.type === 'payment_record'
          ? typeof firstPayment.payment_record === 'string'
            ? firstPayment.payment_record
            : firstPayment.payment_record?.id
          : null;

  const receivedAt = stripeInvoice.status_transitions?.paid_at
    ? new Date(stripeInvoice.status_transitions.paid_at * 1000).toISOString()
    : new Date().toISOString();

  // Single transaction (0018): resolve invoice → insert-or-adopt payment → ledger posting
  // + invoice transition. No crash window between "payment recorded" and "books updated";
  // a redelivery that finds a stranded payment completes its posting instead of skipping.
  const { data: recorded, error: rpcErr } = await sb
    .rpc('record_stripe_payment', {
      p_org_id: orgId(),
      p_stripe_invoice_id: stripeInvoiceId,
      p_stripe_payment_id: stripePaymentId,
      p_amount_cents: stripeInvoice.amount_paid,
      // '' → the RPC's nullif() falls back to the invoice's own currency.
      p_currency: stripeInvoice.currency ? stripeInvoice.currency.toUpperCase() : '',
      p_received_at: receivedAt,
      p_raw: {
        stripe_event_id: stripeEvent.id,
        stripe_invoice_id: stripeInvoiceId,
        payment_ref: paymentRef,
        invoice: stripeInvoice,
      } as unknown as Json,
    })
    .single();
  if (rpcErr) throw rpcErr;
  const result = recorded as {
    rsp_payment_id: string;
    rsp_invoice_id: string;
    rsp_invoice_state: string;
    rsp_was_existing: boolean;
  };

  if (result.rsp_was_existing) {
    log.info('stripe.webhook.duplicate_payment_adopted', {
      stripe_payment_id: stripePaymentId,
      invoice_state: result.rsp_invoice_state,
    });
  }

  await appendEvent({
    type: 'controller.payment.recorded',
    source: 'stripe_webhook',
    agentName: 'controller',
    subjectType: 'invoice',
    subjectId: result.rsp_invoice_id,
    payload: {
      payment_id: result.rsp_payment_id,
      stripe_payment_id: stripePaymentId,
      amount_cents: stripeInvoice.amount_paid,
      currency: (stripeInvoice.currency ?? '').toUpperCase() || null,
      invoice_state: result.rsp_invoice_state,
      was_existing: result.rsp_was_existing,
    },
    idempotencyKey: `controller.payment.recorded:${result.rsp_payment_id}`,
  });
}

let projectorRegistered = false;

export function registerStripeProjectors(): void {
  if (projectorRegistered) return;
  registerProjector('stripe.invoice.paid', projectStripeInvoicePaid);
  projectorRegistered = true;
}
