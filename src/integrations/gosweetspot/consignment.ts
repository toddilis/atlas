import { z } from 'zod';
import { supabase } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';
import type { DispatchContext } from '../../platform/dispatch/read.js';

// GoSweetSpot (NZ Couriers) shipment response for a booked shipment. Each consignment has
// ConsignmentId, Connote (its tracking number) and Cost: the carrier cost excluding tax, in
// dollars. Other fields are kept unchanged as evidence. How Atlas obtains this response
// (booking call, webhook or export) is the connection's concern, not this mapping's.
const Consignment = z.object({
  ConsignmentId: z.union([z.number().int().nonnegative(), z.string().trim().min(1)]),
  Connote: z.string().trim().min(1),
  Cost: z.number().finite().nonnegative(),
}).passthrough();
export const ShipmentResponseSchema = z.object({ Consignments: z.array(Consignment).min(1) }).passthrough();

/** One GoSweetSpot site (account) as configured for a business. Nothing is assumed:
 * the business states the currency its GoSweetSpot costs are in and how long a recorded
 * cost may be used for drafting. */
export const GoSweetSpotConnectionSchema = z.object({
  siteId: z.string().trim().min(1),
  currency: z.string().regex(/^[A-Z]{3}$/),
  validityDays: z.number().int().min(1).max(3650),
}).strict();
export type GoSweetSpotConnection = z.infer<typeof GoSweetSpotConnectionSchema>;

/** Exact dollars-to-cents: a cost with more than two decimals is refused, never rounded. */
export function costMinor(dollars: number): bigint {
  const fixed = dollars.toFixed(2);
  if (!Number.isFinite(dollars) || dollars < 0 || Number(fixed) !== dollars || dollars > 9e12) throw new Error('gosweetspot: cost must be a non-negative amount with at most two decimals');
  return BigInt(fixed.replace('.', ''));
}

const normal = (connote: string) => connote.trim().toUpperCase();

/** Pure mapping from a GoSweetSpot shipment response to carrier cost evidence for one
 * dispatch. The consignments are the ones whose connotes are the dispatch's Shopify
 * tracking numbers; every tracking number must be covered (a shipment may span several
 * consignments, whose costs add), so a partial response never records a partial cost. */
export function consignmentEvidence(raw: unknown, trackingNumbers: string[], connectionValue: unknown, observedAt: Date) {
  const connection = GoSweetSpotConnectionSchema.parse(connectionValue);
  const response = ShipmentResponseSchema.parse(raw);
  const tracking = new Set(trackingNumbers.map(normal).filter(Boolean));
  if (!tracking.size) throw new Error('gosweetspot: the dispatch has no tracking number to match');
  // The same consignment may be listed once per connote queried; identical copies are one
  // consignment, while two different records under one id are refused.
  const byId = new Map<string, (typeof response.Consignments)[number]>();
  for (const c of response.Consignments.filter(c => tracking.has(normal(c.Connote)))) {
    const seen = byId.get(String(c.ConsignmentId));
    if (seen && JSON.stringify(seen) !== JSON.stringify(c)) throw new Error('gosweetspot: conflicting duplicate consignment in response');
    byId.set(String(c.ConsignmentId), c);
  }
  const matched = [...byId.values()];
  const covered = new Set(matched.map(c => normal(c.Connote)));
  if (covered.size !== tracking.size) throw new Error('gosweetspot: response does not cover every tracking number of the dispatch');
  // A zero cost is a consignment not yet priced, not free freight: record nothing and retry.
  if (matched.some(c => costMinor(c.Cost) === 0n)) throw new Error('gosweetspot: consignment has no cost yet; no cost recorded');
  if (Number.isNaN(observedAt.getTime()) || observedAt.getTime() > Date.now()) throw new Error('gosweetspot: observation time must not be in the future');
  const ids = matched.map(c => String(c.ConsignmentId)).sort();
  const total = matched.reduce((sum, c) => sum + costMinor(c.Cost), 0n);
  if (total > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('gosweetspot: cost outside supported range');
  return {
    carrierConnection: `gosweetspot:${connection.siteId}`,
    // One evidence row per observation: a re-sync after expiry records a new observation
    // rather than conflicting with the expired one.
    quoteKey: `consignment:${ids.join('+')}@${observedAt.toISOString()}`,
    currency: connection.currency,
    costMinor: total,
    observedAt: observedAt.toISOString(),
    expiresAt: new Date(observedAt.getTime() + connection.validityDays * 86_400_000).toISOString(),
    evidence: { provider: 'gosweetspot', siteId: connection.siteId, consignments: matched },
  };
}

/** Records the shipment's carrier cost for a Shopify dispatch through the service-only
 * record_carrier_cost RPC (idempotent per observation; changed content is refused).
 * Internal adapter: callers supply a verified business/source context, never a browser. */
export async function recordGoSweetSpotShipment(context: DispatchContext, dispatchId: string, response: unknown,
  connection: unknown, observedAt = new Date()) {
  const sb = supabase();
  const { data: fulfillment, error } = await sb.from('shopify_fulfillments').select('tracking_numbers')
    .eq('org_id', context.orgId).eq('dispatch_id', dispatchId).maybeSingle();
  if (error) throw error;
  if (!fulfillment) throw new Error('gosweetspot: no Shopify fulfillment for this dispatch');
  const e = consignmentEvidence(response, fulfillment.tracking_numbers, connection, observedAt);
  const { data, error: rpcError } = await sb.rpc('record_carrier_cost', {
    p_org_id: context.orgId, p_source_id: context.sourceId, p_dispatch_id: dispatchId,
    p_carrier_connection: e.carrierConnection, p_quote_key: e.quoteKey, p_currency: e.currency,
    p_cost_minor: Number(e.costMinor), p_observed_at: e.observedAt, p_expires_at: e.expiresAt,
    p_evidence: e.evidence as unknown as Json,
  });
  if (rpcError) throw rpcError;
  return { evidenceId: data, ...e, costMinor: e.costMinor.toString() };
}
