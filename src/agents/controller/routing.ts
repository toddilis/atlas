// Location routing — Phase 0 deliverable.
//
// Given a Shopify fulfillment, decide whether it produces a wholesale invoice (main location +
// known wholesale customer), a consignment movement (venue location), or is ignored (anything
// else — including DTC orders shipped from main with no matching B2B account).
//
// Routing is deterministic — no Claude in this path (§10).

import { supabase, orgId } from '../../data/supabase.js';

export type Route = 'wholesale' | 'consignment' | 'ignored';

export interface RoutingDecision {
  route: Route;
  reason: string;
  accountId: string | null;
}

interface RoutingInputs {
  shopifyFulfillmentId: string;            // canonical row id
  shopifyOrderId: string;                  // canonical row id
  locationId: string | null;
}

/**
 * Resolve a routing decision for a fulfillment. Reads:
 *  - VENUE_LOCATION_IDS (comma-separated Shopify location ids) → consignment
 *  - SHOPIFY_MAIN_LOCATION_ID + linked B2B account → wholesale
 *  - anything else → ignored
 */
export async function decideRoute(input: RoutingInputs): Promise<RoutingDecision> {
  const venueIds = (process.env.VENUE_LOCATION_IDS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  const mainId = process.env.SHOPIFY_MAIN_LOCATION_ID?.trim() || null;

  if (input.locationId && venueIds.includes(input.locationId)) {
    return {
      route: 'consignment',
      reason: `location ${input.locationId} is a venue (VENUE_LOCATION_IDS)`,
      accountId: null,
    };
  }

  if (input.locationId && mainId && input.locationId === mainId) {
    const accountId = await resolveAccountForOrder(input.shopifyOrderId);
    if (accountId) {
      return {
        route: 'wholesale',
        reason: 'main location + linked B2B account',
        accountId,
      };
    }
    return {
      route: 'ignored',
      reason: 'main location but no linked B2B account (likely DTC)',
      accountId: null,
    };
  }

  return {
    route: 'ignored',
    reason: input.locationId
      ? `location ${input.locationId} matches neither main nor any venue`
      : 'no location id on fulfillment',
    accountId: null,
  };
}

/**
 * Look up the linked B2B account for a Shopify order: order → shopify_customer → account_id
 * (Seam 2). Returns null when no link exists; the order is treated as DTC (ignored).
 */
async function resolveAccountForOrder(canonicalOrderId: string): Promise<string | null> {
  const sb = supabase();
  const { data: order, error: orderErr } = await sb
    .from('shopify_orders')
    .select('shopify_customer_id')
    .eq('org_id', orgId())
    .eq('id', canonicalOrderId)
    .maybeSingle();
  if (orderErr) throw orderErr;
  if (!order?.shopify_customer_id) return null;

  const { data: customer, error: custErr } = await sb
    .from('shopify_customers')
    .select('account_id')
    .eq('org_id', orgId())
    .eq('shopify_customer_id', order.shopify_customer_id)
    .maybeSingle();
  if (custErr) throw custErr;
  return (customer?.account_id as string | null) ?? null;
}
