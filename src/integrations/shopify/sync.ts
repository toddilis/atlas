// Canonical Shopify sync — Phase 0 deliverable.
//
// Seam 1: we pull ALL customers + ALL orders + ALL products into canonical tables. The
// Controller filters to B2B downstream; Growth (later) reads DTC from the same tables. We
// also sync fulfillments per order so the routing path has consistent local data.
//
// Sync is idempotent: every upsert keys on (org_id, shopify_*_id). Re-running the script
// is safe and updates the canonical row to match Shopify's current state.

import 'dotenv/config';
import { supabase, orgId } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';
import { log } from '../../platform/log.js';
import { iteratePages } from './client.js';

interface ShopifyCustomer {
  id: number | string;
  email?: string | null;
  first_name?: string | null;
  last_name?: string | null;
  default_address?: Record<string, unknown> | null;
  tags?: string;
  created_at?: string | null;
  updated_at?: string | null;
}

interface ShopifyProduct {
  id: number | string;
  title: string;
  variants?: Array<{
    id: number | string;
    sku?: string | null;
    title?: string;
  }>;
}

interface ShopifyOrder {
  id: number | string;
  name?: string;
  customer?: { id: number | string } | null;
  currency: string;
  subtotal_price?: string | null;
  total_tax?: string | null;
  total_price?: string | null;
  financial_status?: string | null;
  fulfillment_status?: string | null;
  tags?: string;
  created_at?: string | null;
  updated_at?: string | null;
  line_items?: Array<{
    id: number | string;
    variant_id?: number | string | null;
    sku?: string | null;
    title?: string | null;
    quantity: number;
    price?: string | null;
  }>;
  fulfillments?: Array<{
    id: number | string;
    location_id?: number | string | null;
    status: string;
    tracking_company?: string | null;
    tracking_numbers?: string[];
    created_at?: string | null;
    updated_at?: string | null;
  }>;
}

function cents(value: string | null | undefined): number {
  if (!value) return 0;
  const n = Number.parseFloat(value);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
}

function tagsArray(tags: string | undefined): string[] {
  if (!tags) return [];
  return tags.split(',').map((t) => t.trim()).filter(Boolean);
}

/** Pull every customer and upsert into shopify_customers. */
export async function syncCustomers(): Promise<number> {
  const sb = supabase();
  let total = 0;
  for await (const batch of iteratePages<ShopifyCustomer>('customers.json', { limit: 250 })) {
    if (batch.length === 0) continue;
    const rows = batch.map((c) => ({
      org_id: orgId(),
      shopify_customer_id: String(c.id),
      email: c.email ?? null,
      first_name: c.first_name ?? null,
      last_name: c.last_name ?? null,
      default_address: (c.default_address ?? null) as unknown as Json,
      tags: tagsArray(c.tags),
      raw: c as unknown as Json,
      created_at_source: c.created_at ?? null,
      updated_at_source: c.updated_at ?? null,
      synced_at: new Date().toISOString(),
    }));
    const { error } = await sb
      .from('shopify_customers')
      .upsert(rows, { onConflict: 'org_id,shopify_customer_id' });
    if (error) throw error;
    total += rows.length;
    log.info('sync.customers.batch', { count: rows.length, total });
  }
  return total;
}

/** Pull every product + variant and upsert into products. */
export async function syncProducts(): Promise<number> {
  const sb = supabase();
  let total = 0;
  for await (const batch of iteratePages<ShopifyProduct>('products.json', { limit: 250 })) {
    if (batch.length === 0) continue;
    const rows = batch.flatMap((p) =>
      (p.variants ?? []).map((v) => ({
        org_id: orgId(),
        sku: v.sku && v.sku.length > 0 ? v.sku : `SHOPIFY-${v.id}`,
        display_name: v.title && v.title !== 'Default Title' ? `${p.title} — ${v.title}` : p.title,
        shopify_product_id: String(p.id),
        shopify_variant_id: String(v.id),
        unit: 'each',
        active: true,
      })),
    );
    if (rows.length === 0) continue;
    const { error } = await sb.from('products').upsert(rows, { onConflict: 'org_id,sku' });
    if (error) throw error;
    total += rows.length;
    log.info('sync.products.batch', { count: rows.length, total });
  }
  return total;
}

/**
 * Pull every order and upsert into shopify_orders / shopify_order_lines / shopify_fulfillments.
 * We ask Shopify to embed line_items and fulfillments inline by status=any so historical
 * orders are included.
 */
export async function syncOrders(): Promise<number> {
  const sb = supabase();
  let total = 0;
  for await (const batch of iteratePages<ShopifyOrder>('orders.json', {
    limit: 250,
    status: 'any',
  })) {
    if (batch.length === 0) continue;

    const orderRows = batch.map((o) => ({
      org_id: orgId(),
      shopify_order_id: String(o.id),
      shopify_order_name: o.name ?? null,
      shopify_customer_id: o.customer?.id ? String(o.customer.id) : null,
      currency: o.currency,
      subtotal_cents: cents(o.subtotal_price),
      total_tax_cents:  cents(o.total_tax),
      total_cents:      cents(o.total_price),
      financial_status: o.financial_status ?? null,
      fulfillment_status: o.fulfillment_status ?? null,
      tags: tagsArray(o.tags),
      raw: o as unknown as Json,
      placed_at: o.created_at ?? null,
      updated_at_source: o.updated_at ?? null,
      synced_at: new Date().toISOString(),
    }));

    const { data: upserted, error } = await sb
      .from('shopify_orders')
      .upsert(orderRows, { onConflict: 'org_id,shopify_order_id' })
      .select('id, shopify_order_id');
    if (error) throw error;

    const idByShopify = new Map(
      (upserted ?? []).map((r) => [r.shopify_order_id as string, r.id as string]),
    );

    // Lines.
    const lineRows = batch.flatMap((o) => {
      const orderId = idByShopify.get(String(o.id));
      if (!orderId) return [];
      return (o.line_items ?? []).map((l) => ({
        org_id: orgId(),
        shopify_order_id: orderId,
        shopify_line_id: String(l.id),
        shopify_variant_id: l.variant_id ? String(l.variant_id) : null,
        sku: l.sku ?? null,
        title: l.title ?? null,
        quantity: l.quantity,
        unit_price_cents: cents(l.price),
        total_cents: cents(l.price) * l.quantity,
        raw: l,
      }));
    });
    if (lineRows.length > 0) {
      const { error: lineErr } = await sb
        .from('shopify_order_lines')
        .upsert(lineRows, { onConflict: 'shopify_order_id,shopify_line_id' });
      if (lineErr) throw lineErr;
    }

    // Fulfillments embedded in the order payload.
    const fulfillmentRows = batch.flatMap((o) => {
      const orderId = idByShopify.get(String(o.id));
      if (!orderId) return [];
      return (o.fulfillments ?? []).map((f) => ({
        org_id: orgId(),
        shopify_fulfillment_id: String(f.id),
        shopify_order_id: orderId,
        location_id: f.location_id ? String(f.location_id) : null,
        location_name: null,
        status: f.status,
        tracking_company: f.tracking_company ?? null,
        tracking_numbers: f.tracking_numbers ?? [],
        raw: f,
        occurred_at: f.created_at ?? f.updated_at ?? new Date().toISOString(),
        synced_at: new Date().toISOString(),
      }));
    });
    if (fulfillmentRows.length > 0) {
      const { error: fErr } = await sb
        .from('shopify_fulfillments')
        .upsert(fulfillmentRows, { onConflict: 'org_id,shopify_fulfillment_id' });
      if (fErr) throw fErr;
    }

    total += orderRows.length;
    log.info('sync.orders.batch', {
      orders: orderRows.length,
      lines: lineRows.length,
      fulfillments: fulfillmentRows.length,
      total,
    });
  }
  return total;
}

export async function syncAll(): Promise<{ customers: number; products: number; orders: number }> {
  const customers = await syncCustomers();
  const products  = await syncProducts();
  const orders    = await syncOrders();
  return { customers, products, orders };
}

// Invocable directly: `npm run sync:shopify`.
const isDirectInvocation = import.meta.url === `file://${process.argv[1]}`;
if (isDirectInvocation) {
  syncAll()
    .then((r) => {
      log.info('sync.complete', r);
      process.exit(0);
    })
    .catch((e) => {
      log.error('sync.failed', { error: (e as Error).message });
      process.exit(1);
    });
}
