import { createHash } from 'node:crypto';
import { appendEvent } from '../../platform/events/eventLog.js';
import type { AppendedEvent } from '../../platform/events/types.js';
import { registerProjector } from '../../platform/events/projector.js';
import { verifyWebhookHmac } from './hmac.js';
import { configuredShopifyDispatchContext, projectShopifyDispatch } from './dispatch.js';
import { log } from '../../platform/log.js';

export interface WebhookResult {
  ok: boolean;
  status: number;
  message: string;
  eventId?: string;
}

/** Authenticate first, durably append with the server binding, then project/retry. */
export async function handleFulfillmentWebhook(
  rawBody: Buffer | string,
  headers: Record<string, string | undefined>,
): Promise<WebhookResult> {
  const signature = headers['x-shopify-hmac-sha256'] ?? headers['X-Shopify-Hmac-Sha256'];
  if (!verifyWebhookHmac(rawBody, signature)) {
    log.warn('webhook.hmac_invalid');
    return { ok: false, status: 401, message: 'invalid hmac' };
  }
  const context = configuredShopifyDispatchContext();
  const shopHeader = headers['x-shopify-shop-domain'] ?? headers['X-Shopify-Shop-Domain'];
  if (shopHeader?.toLowerCase() !== context.connectionKey) {
    return { ok: false, status: 401, message: 'shop does not match the configured connection' };
  }
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  let parsed: unknown;
  try { parsed = JSON.parse(body); } catch {
    return { ok: false, status: 400, message: 'invalid json' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, status: 400, message: 'fulfillment must be an object' };
  }
  const payload = { ...parsed, _atlas_connection: context.connectionKey };
  // Contradictory payloads with the same timestamp must reach the conflict detector.
  // SQL projection deduplicates harmless variations and retains source evidence.
  const digest = createHash('sha256').update(body).digest('hex');
  const event = await appendEvent({
    type: 'shopify.fulfillment.created', source: 'shopify_webhook',
    subjectType: 'shopify_fulfillment', subjectId: null, payload,
    idempotencyKey: `shopify.fulfillment:${context.orgId}:${context.connectionKey}:${digest}`,
  });
  if (!event.projected) {
    return { ok: false, status: 500, message: 'event stored; projection pending retry', eventId: event.id };
  }
  return { ok: true, status: 200, message: 'accepted', eventId: event.id };
}

export async function projectFulfillment(event: AppendedEvent): Promise<void> {
  const connectionKey = event.payload._atlas_connection;
  if (typeof connectionKey !== 'string') {
    throw new Error('legacy Shopify event has no verified connection binding; reconciliation required');
  }
  const { _atlas_connection: _binding, ...payload } = event.payload;
  await projectShopifyDispatch({ orgId: event.orgId, connectionKey }, payload);
}

let projectorRegistered = false;
export function registerShopifyProjectors(): void {
  if (projectorRegistered) return;
  registerProjector('shopify.fulfillment.created', projectFulfillment);
  projectorRegistered = true;
}
