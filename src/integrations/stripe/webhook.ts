// Stripe webhook handler — Phase 1 PR-C. Stripe POSTs to /webhooks/stripe; we verify the
// signature, append the raw event to event_log (idempotent on stripe event id), and let a
// projector turn the event into canonical state (payments row + invoice transition +
// ledger posting via the post_payment_received RPC).
//
// Flow for `invoice.paid`:
//   raw POST → verify sig → appendEvent('stripe.invoice.paid', idempotencyKey=stripe.<evt_id>)
//   → projector: find invoice by stripe_invoice_id → insert payment (idempotent on
//     stripe_payment_id via 0012 unique index) → rpc post_payment_received → emit
//     controller.payment.recorded
//
// Other Stripe event types are accepted but skipped (a future PR adds handlers without
// changing the signature-verification path).

import type Stripe from 'stripe';
import { supabase, orgId } from '../../data/supabase.js';
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

  if (!stripeInvoice.id) {
    throw new Error('stripe.invoice.paid event has no invoice id');
  }

  // Resolve our canonical invoice by the stripe_invoice_id written during outbox drain.
  const { data: canonicalInvoice, error: invErr } = await sb
    .from('invoices')
    .select('id, total_cents, currency, channel, state')
    .eq('org_id', orgId())
    .eq('stripe_invoice_id', stripeInvoice.id)
    .maybeSingle();
  if (invErr) throw invErr;
  if (!canonicalInvoice) {
    throw new Error(
      `stripe.invoice.paid: no canonical invoice for stripe_invoice_id ${stripeInvoice.id}`,
    );
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

  // Insert idempotently — the 0012 unique index on (org_id, stripe_payment_id) makes
  // re-deliveries a no-op so post_payment_received is only called once.
  const { data: paymentRow, error: payErr } = await sb
    .from('payments')
    .insert({
      org_id: orgId(),
      invoice_id: canonicalInvoice.id as string,
      amount_cents: stripeInvoice.amount_paid,
      currency: (stripeInvoice.currency ?? canonicalInvoice.currency).toUpperCase(),
      method: 'stripe',
      stripe_payment_id: stripePaymentId,
      received_at: receivedAt,
      raw: {
        stripe_event_id: stripeEvent.id,
        stripe_invoice_id: stripeInvoice.id,
        payment_ref: paymentRef,
        invoice: stripeInvoice,
      } as unknown as Record<string, unknown>,
    })
    .select('id')
    .maybeSingle();

  if (payErr) {
    if (payErr.code === '23505') {
      // The payment row landed on a previous delivery — but that alone doesn't prove the
      // ledger posting + invoice transition happened: they are a separate RPC round-trip
      // until PR-K folds payment insert + posting into one transaction. Only skip when the
      // transition is actually there; otherwise fail the projection so the event stays
      // recorded as failed (visible, replayable) instead of being silently marked done.
      const invoiceState = canonicalInvoice.state as string;
      if (invoiceState === 'paid' || invoiceState === 'partial') {
        log.info('stripe.webhook.duplicate_payment_skipped', {
          stripe_payment_id: stripePaymentId,
        });
        return;
      }
      throw new Error(
        `payment ${stripePaymentId} recorded but invoice ${canonicalInvoice.id} never ` +
          'transitioned (post_payment_received incomplete); kept failed for replay — ' +
          'PR-K makes this path self-healing',
      );
    }
    throw payErr;
  }
  if (!paymentRow) throw new Error('payments insert returned no row');

  // Atomic ledger posting + invoice state transition.
  const { data: rpc, error: rpcErr } = await sb.rpc('post_payment_received', {
    p_org_id: orgId(),
    p_payment_id: paymentRow.id as string,
  });
  if (rpcErr) throw rpcErr;

  await appendEvent({
    type: 'controller.payment.recorded',
    source: 'stripe_webhook',
    agentName: 'controller',
    subjectType: 'invoice',
    subjectId: canonicalInvoice.id as string,
    payload: {
      payment_id: paymentRow.id,
      stripe_payment_id: stripePaymentId,
      amount_cents: stripeInvoice.amount_paid,
      currency: (stripeInvoice.currency ?? canonicalInvoice.currency).toUpperCase(),
      rpc_result: rpc,
    },
    idempotencyKey: `controller.payment.recorded:${paymentRow.id}`,
  });
}

let projectorRegistered = false;

export function registerStripeProjectors(): void {
  if (projectorRegistered) return;
  registerProjector('stripe.invoice.paid', projectStripeInvoicePaid);
  projectorRegistered = true;
}
