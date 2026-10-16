import { supabase } from '../../data/supabase.js';
import type { DispatchContext } from '../../platform/dispatch/read.js';
import { recordGoSweetSpotShipment, ShipmentResponseSchema } from './consignment.js';

// Shipments are booked in the GoSweetSpot website, so Atlas reads them back: GET
// api/shipments filtered by consignment numbers (`shipments`), which are the connotes
// GoSweetSpot writes to the Shopify fulfillment as tracking numbers.
export const GOSWEETSPOT_API = 'https://api.gosweetspot.com/api';

export interface GoSweetSpotCredentials { accessKey: string; siteId: string }
type Fetch = (url: string, init: { headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;

/** Booked shipments carrying the given connotes. The response is accepted only as shipment
 * objects in the documented api/shipments shape (Consignments with ConsignmentId, Connote,
 * Cost); anything else is refused, so an unexpected format records no cost. */
export async function fetchShipmentsByConnote(credentials: GoSweetSpotCredentials, connotes: string[], fetcher: Fetch = fetch as unknown as Fetch) {
  if (!credentials.accessKey.trim() || !credentials.siteId.trim()) throw new Error('gosweetspot: access key and site id required');
  if (!connotes.length) throw new Error('gosweetspot: no consignment numbers to look up');
  const url = `${GOSWEETSPOT_API}/shipments?shipments=${encodeURIComponent(connotes.join(','))}&pagesize=250`;
  const response = await fetcher(url, { headers: { access_key: credentials.accessKey, site_id: credentials.siteId, accept: 'application/json' } });
  if (!response.ok) throw new Error(`gosweetspot: shipments lookup failed with HTTP ${response.status}`);
  const body = await response.json();
  const list = Array.isArray(body) ? body : [body];
  const shipments = list.map(item => {
    const parsed = ShipmentResponseSchema.safeParse(item);
    if (!parsed.success) throw new Error('gosweetspot: unexpected shipments response shape; no cost recorded');
    return parsed.data;
  });
  return { Consignments: shipments.flatMap(s => s.Consignments) };
}

/** Pull path for one Shopify dispatch: read its fulfillment tracking numbers, look up the
 * booked consignments in GoSweetSpot and record their cost as carrier evidence. Credentials
 * come from the caller's secret store; this function never reads production config itself. */
export async function syncGoSweetSpotCost(context: DispatchContext, dispatchId: string, credentials: GoSweetSpotCredentials,
  connection: { currency: string; validityDays: number }, fetcher?: Fetch) {
  const { data: fulfillment, error } = await supabase().from('shopify_fulfillments').select('tracking_numbers')
    .eq('org_id', context.orgId).eq('dispatch_id', dispatchId).maybeSingle();
  if (error) throw error;
  if (!fulfillment?.tracking_numbers.length) throw new Error('gosweetspot: the dispatch has no tracking number to look up');
  const response = await fetchShipmentsByConnote(credentials, fulfillment.tracking_numbers, fetcher);
  return recordGoSweetSpotShipment(context, dispatchId, response, { siteId: credentials.siteId, ...connection });
}
