import { supabase, orgId } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';

export interface ShopifyDispatchContext {
  orgId: string;
  connectionKey: string;
}

/** Trusted single-deployment binding; never populate this from a webhook's org_id. */
export function configuredShopifyDispatchContext(): ShopifyDispatchContext {
  const connectionKey = process.env.SHOPIFY_SHOP_DOMAIN?.trim().toLowerCase();
  if (!connectionKey || !/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/.test(connectionKey)) {
    throw new Error('SHOPIFY_SHOP_DOMAIN must be the canonical myshopify.com domain');
  }
  return { orgId: orgId(), connectionKey };
}

function assertSourceId(value: unknown, name: string): void {
  if ((typeof value === 'number' && (!Number.isSafeInteger(value) || value <= 0))
    || (typeof value !== 'number' && (typeof value !== 'string' || !/^[0-9]+$/.test(value)))) {
    throw new Error(`invalid Shopify ${name}; numeric IDs must be safe integers or decimal strings`);
  }
}

/**
 * Both bulk sync and durable webhook replay use this adapter RPC. The RPC resolves the
 * original order/line in the bound business, then atomically projects the generic
 * dispatch and legacy header. Missing originals throw and remain recoverable events.
 */
export async function projectShopifyDispatch(
  context: ShopifyDispatchContext,
  payload: Record<string, unknown>,
): Promise<string> {
  const configured = configuredShopifyDispatchContext();
  if (context.orgId !== configured.orgId || context.connectionKey !== configured.connectionKey) {
    throw new Error('Shopify replay context does not match the configured business/connection');
  }
  assertSourceId(payload.id, 'fulfillment ID');
  assertSourceId(payload.order_id, 'order ID');
  // Reject lossy JS ID parsing; malformed line shapes otherwise become visible SQL exceptions.
  if (Array.isArray(payload.line_items)) {
    for (const line of payload.line_items) {
      if (line && typeof line === 'object' && typeof line.id === 'number') assertSourceId(line.id, 'line ID');
    }
  }
  const { data, error } = await supabase().rpc('project_shopify_dispatch', {
    p_org_id: context.orgId,
    p_connection_key: context.connectionKey,
    p_payload: payload as Json,
  });
  if (error) throw error;
  if (typeof data !== 'string') throw new Error('Shopify dispatch projection returned no identity');
  return data;
}
