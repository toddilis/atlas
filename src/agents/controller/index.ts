// Controller — Agent #1: Finance.
//
// Responsibilities:
//   - subscribe to shopify.fulfillment.created
//   - resolve location routing (Phase 0)
//   - upsert a fulfillment_events row (wholesale / consignment / ignored, with reason)
//   - emit a controller.fulfillment.routed event for downstream wiring
//   - record an observation tying the routing to its source event
//   - append agent_activity describing the decision
//   - PR-D: auto-draft an invoice for wholesale routes via the draft_invoice tool. Draft
//     failures are logged but don't roll back routing — drafting is idempotent on
//     fulfillment_event_id, so the operator can retry after fixing pricing data.
//   - PR-E: GST baked into draft_invoice_atomic via the org rate + account exemption.
//   - PR-F: generate_statement tool — operator-triggered (or scheduled) snapshot of an
//     account's billing position. No money moves; sending the statement to the customer
//     is a separate later tool with its own gate.

import { supabase, orgId } from '../../data/supabase.js';
import type { AgentDefinition } from '../../platform/agent/types.js';
import { recordActivity } from '../../platform/agent/activity.js';
import { recordObservation } from '../../platform/memory/observations.js';
import { appendEvent } from '../../platform/events/eventLog.js';
import { log } from '../../platform/log.js';
import { decideRoute } from './routing.js';

async function onShopifyFulfillmentCreated(event: {
  id: string;
  payload: Record<string, unknown>;
  occurredAt: string;
}): Promise<void> {
  const sb = supabase();
  const shopifyFulfillmentId = String(
    (event.payload as { id?: string | number }).id ?? '',
  );
  if (!shopifyFulfillmentId) {
    log.warn('controller.fulfillment.missing_id', { event_id: event.id });
    return;
  }

  // The webhook projector has already upserted the canonical row.
  const { data: canonical, error } = await sb
    .from('shopify_fulfillments')
    .select('id, shopify_order_id, location_id, occurred_at')
    .eq('org_id', orgId())
    .eq('shopify_fulfillment_id', shopifyFulfillmentId)
    .maybeSingle();
  if (error) throw error;
  if (!canonical) {
    throw new Error(`canonical shopify_fulfillments row missing for ${shopifyFulfillmentId}`);
  }

  const decision = await decideRoute({
    shopifyFulfillmentId: canonical.id as string,
    shopifyOrderId: canonical.shopify_order_id as string,
    locationId: (canonical.location_id as string | null) ?? null,
  });

  const { data: feRow, error: upsertErr } = await sb
    .from('fulfillment_events')
    .upsert(
      {
        org_id: orgId(),
        shopify_fulfillment_id: canonical.id as string,
        shopify_order_id: canonical.shopify_order_id as string,
        account_id: decision.accountId,
        route: decision.route,
        reason: decision.reason,
        occurred_at: canonical.occurred_at as string,
      },
      { onConflict: 'org_id,shopify_fulfillment_id' },
    )
    .select('id')
    .single();
  if (upsertErr) throw upsertErr;
  const fulfillmentEventId = feRow.id as string;

  // Dedup keys make the handler safe under projector re-dispatch/replay (PR-J): the
  // canonical upserts above already dedup, and these keep the narrative + memory streams
  // from duplicating on retry.
  await recordActivity({
    agentName: 'controller',
    kind: 'decision',
    summary: `Fulfillment routed: ${decision.route} — ${decision.reason}`,
    subjectType: 'shopify_fulfillment',
    subjectId: canonical.id as string,
    eventId: event.id,
    detail: { route: decision.route, reason: decision.reason, account_id: decision.accountId },
    dedupKey: `controller.fulfillment.routed:${canonical.id}`,
  });

  await recordObservation({
    agentName: 'controller',
    kind: 'fact',
    content: `Routed fulfillment ${shopifyFulfillmentId} as ${decision.route} (${decision.reason})`,
    subjectType: 'shopify_fulfillment',
    subjectId: canonical.id as string,
    sourceEventId: event.id,
    dedupKey: `controller.fulfillment.routed:${canonical.id}`,
  });

  await appendEvent({
    type: 'controller.fulfillment.routed',
    source: 'controller',
    agentName: 'controller',
    subjectType: 'shopify_fulfillment',
    subjectId: canonical.id as string,
    payload: {
      route: decision.route,
      reason: decision.reason,
      account_id: decision.accountId,
      shopify_fulfillment_id: shopifyFulfillmentId,
      shopify_order_id: canonical.shopify_order_id,
      fulfillment_event_id: fulfillmentEventId,
    },
    idempotencyKey: `controller.fulfillment.routed:${canonical.id}`,
  });

  // Wholesale shipments are invoiced as dispatch parts by the invoice part job (0035),
  // which the worker discovers from this routing record. The legacy whole-order draft
  // already refused every dispatch-backed fulfillment, so it is no longer called here.
}

export const controllerAgent: AgentDefinition = {
  name: 'controller',
  domain: 'finance',
  kind: 'worker',
  description: 'Agent #1 — Finance. Phase 0: location routing for Shopify fulfillments.',
  triggers: ['shopify.fulfillment.created'],
  tools: [
    'shopify.list_orders',
    'shopify.list_customers',
    'shopify.list_products',
    'shopify.list_fulfillments',
    'controller.draft_invoice',
    'controller.issue_invoice',
    'controller.generate_statement',
  ],
  readScope: [
    'shopify_customers',
    'shopify_orders',
    'shopify_order_lines',
    'shopify_fulfillments',
    'accounts',
    'products',
    'price_books',
    'price_book_entries',
    'fulfillment_events',
    'invoices',
    'payments',
    'statements',
    'observations',
  ],
  onEvent: onShopifyFulfillmentCreated,
};
