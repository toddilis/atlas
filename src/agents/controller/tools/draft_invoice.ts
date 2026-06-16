// controller.draft_invoice — builds an invoice draft from a wholesale fulfillment_event.
//
// Flow:
//   input  → { fulfillmentEventId }
//   handler →
//     1. load fulfillment_event; verify route='wholesale' and account_id is set
//     2. load shopify_order_lines for the shopify_order_id
//     3. resolve products from order_line.sku
//     4. resolve unit prices via the pricing module (account-bound or org-default book)
//     5. call draft_invoice_atomic RPC — one transaction inserts invoices + invoice_lines
//        and assigns the next invoice number
//     6. emit controller.invoice.drafted
//
// Risk tier is 'auto' — drafts don't move money. The state transition to 'issued' (PR-B)
// is what trips the policy engine + approval gate.

import { supabase, orgId } from '../../../data/supabase.js';
import { appendEvent } from '../../../platform/events/eventLog.js';
import { resolvePricesForAccount } from '../../../platform/pricing/resolve.js';
import type { ToolContext } from '../../../platform/tools/registry.js';

export interface DraftInvoiceInput {
  fulfillmentEventId: string;
}

export interface DraftInvoiceOutput {
  invoiceId: string;
  invoiceNumber: string;
  state: string;
  totalCents: number;
  reused: boolean;            // true if the RPC returned an existing draft
}

interface OrderLine {
  product_id: string;
  description: string;
  quantity: number;
  unit_price_cents: number;
}

export async function execute(
  input: DraftInvoiceInput,
  _ctx: ToolContext,
): Promise<DraftInvoiceOutput> {
  const sb = supabase();
  const org = orgId();

  // 1. Load the fulfillment event + verify it's wholesale.
  const { data: fe, error: feErr } = await sb
    .from('fulfillment_events')
    .select('id, shopify_order_id, account_id, route')
    .eq('org_id', org)
    .eq('id', input.fulfillmentEventId)
    .maybeSingle();
  if (feErr) throw feErr;
  if (!fe) throw new Error(`draft_invoice: fulfillment_event ${input.fulfillmentEventId} not found`);
  if (fe.route !== 'wholesale') {
    throw new Error(
      `draft_invoice: fulfillment ${input.fulfillmentEventId} routed ${fe.route}, not wholesale`,
    );
  }
  if (!fe.account_id) {
    throw new Error(
      `draft_invoice: wholesale fulfillment ${input.fulfillmentEventId} has no account_id`,
    );
  }

  // 2. Load the shopify_order_lines for this order. quantity drives the invoice line
  //    quantity; SKU drives the product resolution.
  const { data: orderLines, error: olErr } = await sb
    .from('shopify_order_lines')
    .select('sku, title, quantity')
    .eq('org_id', org)
    .eq('shopify_order_id', fe.shopify_order_id as string);
  if (olErr) throw olErr;
  if (!orderLines || orderLines.length === 0) {
    throw new Error(
      `draft_invoice: shopify_order ${fe.shopify_order_id} has no order lines`,
    );
  }

  // 3. Resolve SKUs → product_ids. Missing SKUs are a hard error — the canonical sync is
  //    supposed to have these by the time a fulfillment hits us.
  const skus = Array.from(
    new Set(orderLines.map((r) => r.sku as string | null).filter((s): s is string => !!s)),
  );
  if (skus.length === 0) {
    throw new Error(`draft_invoice: order ${fe.shopify_order_id} has no SKUs on its lines`);
  }
  const { data: products, error: prodErr } = await sb
    .from('products')
    .select('id, sku, display_name')
    .eq('org_id', org)
    .in('sku', skus);
  if (prodErr) throw prodErr;
  const productBySku = new Map<string, { id: string; displayName: string }>(
    (products ?? []).map((p) => [
      p.sku as string,
      { id: p.id as string, displayName: (p.display_name as string) ?? (p.sku as string) },
    ]),
  );
  const missingSkus = skus.filter((s) => !productBySku.has(s));
  if (missingSkus.length > 0) {
    throw new Error(
      `draft_invoice: products missing for skus ${missingSkus.join(', ')}`,
    );
  }

  // 4. Resolve prices for those products against the account's price book.
  const productIds = Array.from(new Set([...productBySku.values()].map((p) => p.id)));
  const { resolved, missing } = await resolvePricesForAccount({
    accountId: fe.account_id as string,
    productIds,
  });
  if (missing.length > 0) {
    throw new Error(
      `draft_invoice: prices missing for products ${missing.join(', ')}`,
    );
  }
  const priceByProductId = new Map(resolved.map((r) => [r.productId, r]));

  // All resolved prices must share a currency — the price book invariant guarantees this
  // (currency is a column on price_books, and we picked one book). Asserting anyway to
  // catch any future per-product currency override.
  const currencies = new Set(resolved.map((r) => r.currency));
  if (currencies.size !== 1) {
    throw new Error(`draft_invoice: mixed currencies on resolved prices: ${[...currencies].join(', ')}`);
  }
  const currency = resolved[0]!.currency;

  // 5. Build the line array. Group order lines by sku → product to handle split shipments
  //    of the same SKU on a single order.
  const lineBySku = new Map<string, OrderLine>();
  for (const ol of orderLines) {
    const sku = ol.sku as string | null;
    if (!sku) continue;
    const product = productBySku.get(sku)!;
    const price = priceByProductId.get(product.id)!;
    const qty = Number(ol.quantity ?? 0);
    const existing = lineBySku.get(sku);
    if (existing) {
      existing.quantity += qty;
    } else {
      lineBySku.set(sku, {
        product_id: product.id,
        description: product.displayName,
        quantity: qty,
        unit_price_cents: price.unitPriceCents,
      });
    }
  }
  const lines = [...lineBySku.values()];

  // 6. Atomic insert via the RPC.
  const { data, error: rpcErr } = await sb.rpc('draft_invoice_atomic', {
    p_org_id: org,
    p_account_id: fe.account_id as string,
    p_fulfillment_event_id: fe.id as string,
    p_currency: currency,
    p_lines: lines,
  });
  if (rpcErr) throw rpcErr;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error(`draft_invoice: rpc returned no row`);

  const reused = Boolean(row.was_existing);

  // Append controller.invoice.drafted only on first creation. The idempotency_key would
  // collapse a duplicate append anyway, but the explicit guard keeps the spine clean.
  if (!reused) {
    await appendEvent({
      type: 'controller.invoice.drafted',
      source: 'controller',
      agentName: 'controller',
      subjectType: 'invoice',
      subjectId: row.invoice_id as string,
      payload: {
        invoice_id: row.invoice_id,
        invoice_number: row.invoice_number,
        account_id: fe.account_id,
        fulfillment_event_id: fe.id,
        total_cents: Number(row.total_cents),
        currency,
        line_count: lines.length,
      },
      idempotencyKey: `controller.invoice.drafted:${row.invoice_id}`,
    });
  }

  return {
    invoiceId: row.invoice_id as string,
    invoiceNumber: row.invoice_number as string,
    state: row.state as string,
    totalCents: Number(row.total_cents),
    reused,
  };
}
