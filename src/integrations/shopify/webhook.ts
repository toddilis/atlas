// Shopify fulfillment webhook handler — Phase 0 deliverable.
//
// Flow: receive POST → verify HMAC → idempotently append a shopify.fulfillment.created event →
// projector upserts canonical shopify_fulfillments → controller's onEvent fires routing →
// fulfillment_events row recorded with route + reason.

import { supabase, orgId } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';
import { appendEvent } from '../../platform/events/eventLog.js';
import { registerProjector } from '../../platform/events/projector.js';
import { verifyWebhookHmac } from './hmac.js';
import { log } from '../../platform/log.js';

export interface FulfillmentWebhookPayload {
  id: number | string;
  order_id: number | string;
  location_id?: number | string | null;
  status: string;
  tracking_company?: string | null;
  tracking_numbers?: string[];
  created_at?: string | null;
  updated_at?: string | null;
}

export interface WebhookResult {
  ok: boolean;
  status: number;
  message: string;
  eventId?: string;
}

/**
 * Process a fulfillment webhook. Returns the HTTP response shape the API layer should send
 * back to Shopify — non-2xx means Shopify will retry (which is what we want on failure).
 */
export async function handleFulfillmentWebhook(
  rawBody: Buffer | string,
  headers: Record<string, string | undefined>,
): Promise<WebhookResult> {
  const signature = headers['x-shopify-hmac-sha256'] ?? headers['X-Shopify-Hmac-Sha256'];
  if (!verifyWebhookHmac(rawBody, signature)) {
    log.warn('webhook.hmac_invalid');
    return { ok: false, status: 401, message: 'invalid hmac' };
  }

  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  let payload: FulfillmentWebhookPayload;
  try {
    payload = JSON.parse(body) as FulfillmentWebhookPayload;
  } catch {
    return { ok: false, status: 400, message: 'invalid json' };
  }

  // Idempotency key = shopify fulfillment id + updated_at. A duplicate delivery of the same
  // fulfillment update will hit the unique constraint on event_log.idempotency_key and become
  // a no-op append.
  const idempotencyKey = `shopify.fulfillment:${payload.id}:${payload.updated_at ?? payload.created_at ?? ''}`;

  const event = await appendEvent({
    type: 'shopify.fulfillment.created',
    source: 'shopify_webhook',
    subjectType: 'shopify_fulfillment',
    subjectId: null,                       // canonical row id not known until projection
    payload: payload as unknown as Record<string, unknown>,
    occurredAt: payload.created_at ? new Date(payload.created_at) : new Date(),
    idempotencyKey,
  });

  if (!event.projected) {
    // The append is durable; the projection failed and was recorded (0017). Non-2xx makes
    // Shopify redeliver — the dedup path re-dispatches unprojected events — and the replay
    // loop is the backstop once redeliveries run out.
    return { ok: false, status: 500, message: 'event stored; projection pending retry', eventId: event.id };
  }

  return { ok: true, status: 200, message: 'accepted', eventId: event.id };
}

/**
 * Projector: takes a shopify.fulfillment.created event and upserts the canonical
 * shopify_fulfillments row. We resolve shopify_order_id → canonical row id by lookup;
 * if the order isn't yet in the canonical table (rare, but possible if the webhook arrives
 * before the order has been synced), we raise so the projection will be retried by replay.
 */
async function projectFulfillment(event: { payload: Record<string, unknown> }): Promise<void> {
  const sb = supabase();
  const p = event.payload as unknown as FulfillmentWebhookPayload;

  const { data: order, error: orderErr } = await sb
    .from('shopify_orders')
    .select('id')
    .eq('org_id', orgId())
    .eq('shopify_order_id', String(p.order_id))
    .maybeSingle();
  if (orderErr) throw orderErr;
  if (!order) {
    throw new Error(`shopify order not yet synced: ${p.order_id}`);
  }

  const row = {
    org_id: orgId(),
    shopify_fulfillment_id: String(p.id),
    shopify_order_id: order.id as string,
    location_id: p.location_id != null ? String(p.location_id) : null,
    location_name: null,
    status: p.status,
    tracking_company: p.tracking_company ?? null,
    tracking_numbers: p.tracking_numbers ?? [],
    raw: p as unknown as Json,
    occurred_at: p.created_at ?? p.updated_at ?? new Date().toISOString(),
    synced_at: new Date().toISOString(),
  };

  const { error } = await sb
    .from('shopify_fulfillments')
    .upsert(row, { onConflict: 'org_id,shopify_fulfillment_id' });
  if (error) throw error;
}

let projectorRegistered = false;

export function registerShopifyProjectors(): void {
  if (projectorRegistered) return;
  registerProjector('shopify.fulfillment.created', projectFulfillment);
  projectorRegistered = true;
}
