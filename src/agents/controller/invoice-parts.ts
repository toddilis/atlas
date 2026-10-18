import { supabase } from '../../data/supabase.js';
import { readDispatch, type DispatchContext } from '../../platform/dispatch/read.js';
import { PricingConfigSchema, type PricingInput } from '../../platform/pricing/versioned.js';
import { selectPricingVersion } from '../../platform/pricing/configuration.js';
import { messageOf, runJobPass, scheduledJobs, type JobsStore } from '../../platform/jobs/store.js';
import { draftPricedDispatch } from './priced-dispatch.js';

// Step 4c: the Controller drafts each wholesale shipment's invoice part itself, as a JOBS-01
// job (0035). The input comes only from stored records: the dispatch and its lines, the
// products their SKUs name, the order's date and the pricing version in effect for the
// shipment. draftPricedDispatch then derives the retailer, tax treatment, part order and
// carrier cost, and draft_dispatch_invoice checks every amount again. Nothing is guessed:
// a missing record is the job's blocked reason.

/** The pricing version and calculator input for one dispatch, from stored records. */
export async function dispatchDraftRequest(context: DispatchContext, dispatchId: string, now = new Date()): Promise<{ pricingVersionId: string; input: PricingInput }> {
  const sb = supabase();
  const dispatch = await readDispatch(context, dispatchId);
  if (!dispatch) throw new Error('billing: dispatch not found');
  if (!dispatch.source_occurred_at) throw new Error('billing: the shipment has no dispatch time');
  const { data: order, error: orderError } = await sb.from('shopify_orders').select('placed_at')
    .eq('org_id', context.orgId).eq('id', dispatch.order_key).maybeSingle();
  if (orderError) throw orderError;
  if (!order?.placed_at) throw new Error('billing: the order has no order date');
  if (dispatch.lines.some(l => !l.item_key)) throw new Error('billing: a shipped line has no SKU to price');
  const skus = [...new Set(dispatch.lines.map(l => l.item_key!))];
  const { data: products, error: productError } = await sb.from('products').select('id, sku')
    .eq('org_id', context.orgId).eq('active', true).in('sku', skus);
  if (productError) throw productError;
  const lines = dispatch.lines.map(line => {
    const matches = (products ?? []).filter(p => p.sku === line.item_key);
    if (matches.length !== 1) throw new Error(`billing: no single active product for SKU ${line.item_key}`);
    // Description, quantities and the retailer are re-derived by the draft from the same rows.
    return { lineId: line.id, productId: matches[0]!.id, description: line.item_key!, ordered: line.ordered_quantity, dispatched: line.quantity, override: null };
  });
  const { data: activations, error: activationError } = await sb.from('pricing_activations')
    .select('version_id, version:pricing_versions!inner(id, config)').eq('org_id', context.orgId);
  if (activationError) throw activationError;
  const versions = (activations ?? []).map(a => (a.version as unknown as { id: string; config: unknown }));
  if (!versions.length) throw new Error('billing: no pricing version is active; activate one in Pricing');
  // The version in effect at the pricing instant, which is the order or dispatch date as
  // that version says. If the two dates select versions that disagree, nothing is drafted.
  const configs = versions.map(v => PricingConfigSchema.parse(v.config));
  let chosen = selectPricingVersion(configs, context.orgId, dispatch.source_occurred_at);
  if (chosen.pricingDateBasis === 'order') {
    const byOrder = selectPricingVersion(configs, context.orgId, order.placed_at);
    if (byOrder.pricingDateBasis !== 'order') throw new Error('billing: pricing versions disagree on the pricing date; check Pricing');
    chosen = byOrder;
  }
  const version = versions.find(v => (v.config as { version?: string }).version === chosen.version);
  if (!version) throw new Error(`billing: active pricing version ${chosen.version} not found`);
  const at = now.toISOString();
  return {
    pricingVersionId: version.id,
    input: {
      businessId: context.orgId, accountId: 'derived-by-draft', orderKey: dispatch.order_key, dispatchKey: dispatch.source_dispatch_key,
      orderAt: order.placed_at, dispatchAt: dispatch.source_occurred_at, evaluatedAt: at, destination: null, lines,
      carrier: null, freightOverride: null, priorParts: 0, taxExempt: false, orderValue: null,
      terms: { kind: 'following_month_day', day: chosen.terms.day, anchor: chosen.terms.anchor, invoiceAt: at },
    },
  };
}

export async function draftDispatchPart(context: DispatchContext, dispatchId: string) {
  const request = await dispatchDraftRequest(context, dispatchId);
  return draftPricedDispatch(context, { dispatchId, ...request });
}

// Waiting on another process or a race: try again shortly. Everything else needs a person
// (or an event that wakes the job: a carrier cost, an earlier part, a pricing activation).
// A dispatch revised by a Shopify sync mid-draft is a race too: the retry re-reads it, and
// a dispatch that is no longer eligible closes its job as not needed at the next claim.
const TRANSIENT = [/fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|timed? ?out|aborted/i, /stale part order/, /stale or inactive pricing snapshot/,
  /being invoiced by BILL/, /not eligible at the expected revision/, /could not serialize|deadlock/, /HTTP 5\d\d/];
export function classifyInvoicePart(error: unknown): 'retry' | 'blocked' {
  const message = messageOf(error);
  return TRANSIENT.some(p => p.test(message)) ? 'retry' : 'blocked';
}

export const invoicePartJobs: JobsStore = scheduledJobs('invoice_part_draft');
export type PartDraft = (context: DispatchContext, dispatchId: string) => Promise<unknown>;

/** One scheduler pass for a business: discover wholesale shipments without a part, then draft up to `limit`. */
export async function runInvoicePartJobs(orgId: string, options: { limit?: number; store?: JobsStore; draft?: PartDraft } = {}) {
  const draft = options.draft ?? draftDispatchPart;
  return runJobPass(orgId, options.store ?? invoicePartJobs, async job => {
    const result = await draft({ orgId, sourceId: job.source_id }, job.dispatch_id) as { invoiceId?: string; snapshotId?: string; reused?: boolean } | null;
    return { invoice_id: result?.invoiceId ?? null, snapshot_id: result?.snapshotId ?? null, reused: result?.reused ?? null };
  }, classifyInvoicePart, options.limit ?? 20);
}
