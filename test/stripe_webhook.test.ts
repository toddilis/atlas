// Stripe webhook tests — covers the env-driven signature-verification branches that don't
// require a DB. The projector (which inserts a payments row + calls post_payment_received)
// is verified live, same convention as routing.test.ts.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';

const SECRET = 'whsec_test_pr_c_only';

async function load() {
  // Set the secret before the module materialises a cached client.
  process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_unused';
  process.env.STRIPE_WEBHOOK_SECRET = SECRET;
  return await import('../src/integrations/stripe/webhook.js');
}

function buildSignedDelivery(event: Record<string, unknown>): {
  raw: Buffer;
  headers: Record<string, string>;
} {
  const raw = Buffer.from(JSON.stringify(event), 'utf8');
  const header = Stripe.webhooks.generateTestHeaderString({
    payload: raw.toString('utf8'),
    secret: SECRET,
  });
  return { raw, headers: { 'stripe-signature': header } };
}

test('handleStripeWebhook rejects when signature header is missing', async () => {
  const { handleStripeWebhook } = await load();
  const raw = Buffer.from('{}', 'utf8');
  const result = await handleStripeWebhook(raw, {});
  assert.equal(result.ok, false);
  assert.equal(result.status, 400);
  assert.match(result.message, /missing stripe-signature/);
});

test('handleStripeWebhook rejects an invalid signature', async () => {
  const { handleStripeWebhook } = await load();
  const raw = Buffer.from(JSON.stringify({ id: 'evt_1', type: 'invoice.paid' }), 'utf8');
  const result = await handleStripeWebhook(raw, { 'stripe-signature': 'not-a-real-sig' });
  assert.equal(result.ok, false);
  assert.equal(result.status, 401);
  assert.match(result.message, /invalid signature/);
});

test('handleStripeWebhook accepts a valid signature for an unhandled type without DB IO', async () => {
  const { handleStripeWebhook } = await load();
  const event = {
    id: 'evt_unhandled_1',
    type: 'customer.created',
    created: Math.floor(Date.now() / 1000),
    data: { object: { id: 'cus_1' } },
  };
  const { raw, headers } = buildSignedDelivery(event);
  const result = await handleStripeWebhook(raw, headers);
  assert.equal(result.ok, true);
  assert.equal(result.status, 200);
  assert.match(result.message, /unhandled type/);
});
