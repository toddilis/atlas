// Location routing — Phase 0 deliverable, with the per-customer invoicing decision
// (CONFIG-01d, 0054).
//
// Given a Shopify fulfillment, decide whether it produces a wholesale invoice, a
// consignment movement (venue location), waits for a person (held), or is ignored.
// From the main location the order and its Shopify customer decide:
//   * customer linked to a retailer: invoiced when Shopify shows the order unpaid; an order
//     Shopify shows as paid is never invoiced ("paid means paid", owner, 4 Nov 2026);
//   * customer marked not invoiced (for example a rep's kit): ignored;
//   * undecided customer: an unpaid draft order is held until someone links the customer
//     or marks it not invoiced on the console's Customers page, which releases it; any
//     other order is a retail order and ignored.
//
// Routing is deterministic — no Claude in this path (§10).

import { supabase, orgId } from '../../data/supabase.js';

export type Route = 'wholesale' | 'consignment' | 'ignored' | 'held';

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

/** What routing needs to know about the shipped order, from the synced row. */
export interface OrderFacts {
  shopifyCustomerId: string | null;
  /** Shopify's financial_status: 'pending' is unpaid (payment due later); anything else is not invoiced. */
  financialStatus: string | null;
  /** Shopify's source_name: 'shopify_draft_order' for orders staff entered as draft orders. */
  sourceName: string | null;
}

/** The business's decision about the order's Shopify customer (0054), or null when unknown to Atlas. */
export interface CustomerFacts {
  accountId: string | null;
  doNotInvoice: boolean;
}

export const DRAFT_ORDER_SOURCE = 'shopify_draft_order';

/** The decision for a shipment from the main location, from stored facts alone. */
export function routeMainLocation(order: OrderFacts, customer: CustomerFacts | null): RoutingDecision {
  const unpaid = order.financialStatus === 'pending';
  const status = order.financialStatus ?? 'payment status unknown';
  if (customer?.accountId) {
    return unpaid
      ? { route: 'wholesale', reason: 'main location + linked retailer + unpaid in Shopify', accountId: customer.accountId }
      : { route: 'ignored', reason: `main location + linked retailer, but ${status} in Shopify: not invoiced`, accountId: null };
  }
  if (customer?.doNotInvoice) {
    return { route: 'ignored', reason: 'main location, customer marked not invoiced', accountId: null };
  }
  if (order.sourceName === DRAFT_ORDER_SOURCE && unpaid) {
    return order.shopifyCustomerId
      ? { route: 'held', reason: 'unpaid draft order from a customer not yet linked to a retailer: decide on the Customers page', accountId: null }
      : { route: 'ignored', reason: 'unpaid draft order without a Shopify customer: invoice it by hand', accountId: null };
  }
  return { route: 'ignored', reason: 'main location, customer not linked to a retailer (retail order)', accountId: null };
}

/**
 * Resolve a routing decision for a fulfillment. Reads:
 *  - VENUE_LOCATION_IDS (comma-separated Shopify location ids) → consignment
 *  - SHOPIFY_MAIN_LOCATION_ID → the order and its customer decide (routeMainLocation)
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
    const { order, customer } = await loadRoutingFacts(input.shopifyOrderId);
    return routeMainLocation(order, customer);
  }

  return {
    route: 'ignored',
    reason: input.locationId
      ? `location ${input.locationId} matches neither main nor any venue`
      : 'no location id on fulfillment',
    accountId: null,
  };
}

/** The shipped order's facts and its Shopify customer's decision (Seam 2: order → customer → retailer). */
async function loadRoutingFacts(canonicalOrderId: string): Promise<{ order: OrderFacts; customer: CustomerFacts | null }> {
  const sb = supabase();
  const { data: row, error: orderErr } = await sb
    .from('shopify_orders')
    .select('shopify_customer_id, financial_status, source_name:raw->>source_name')
    .eq('org_id', orgId())
    .eq('id', canonicalOrderId)
    .maybeSingle();
  if (orderErr) throw orderErr;
  if (!row) throw new Error(`canonical shopify_orders row missing for ${canonicalOrderId}`);
  const found = row as { shopify_customer_id: string | null; financial_status: string | null; source_name: string | null };
  const order: OrderFacts = {
    shopifyCustomerId: found.shopify_customer_id ?? null,
    financialStatus: found.financial_status ?? null,
    sourceName: found.source_name ?? null,
  };
  if (!order.shopifyCustomerId) return { order, customer: null };

  const { data: customer, error: custErr } = await sb
    .from('shopify_customers')
    .select('account_id, do_not_invoice')
    .eq('org_id', orgId())
    .eq('shopify_customer_id', order.shopifyCustomerId)
    .maybeSingle();
  if (custErr) throw custErr;
  return {
    order,
    customer: customer ? { accountId: (customer.account_id as string | null) ?? null, doNotInvoice: Boolean(customer.do_not_invoice) } : null,
  };
}
