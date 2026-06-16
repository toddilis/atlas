// Stripe SDK client — Phase 1 PR-C. Lazy-init pattern mirrors the Shopify client so the
// module can be imported during tool-registry boot without forcing an outbound network
// call at module-load time. The drainer wakes the client on first use.

import Stripe from 'stripe';

let client: Stripe | null = null;

export function stripe(): Stripe {
  if (client) return client;
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) {
    throw new Error('STRIPE_SECRET_KEY is not set');
  }
  // apiVersion pinned so SDK upgrades don't silently change Stripe's response shape.
  client = new Stripe(key, { apiVersion: '2026-05-27.dahlia' });
  return client;
}

export function webhookSecret(): string {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!secret) {
    throw new Error('STRIPE_WEBHOOK_SECRET is not set');
  }
  return secret;
}
