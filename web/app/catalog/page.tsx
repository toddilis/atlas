// Catalogue (0040) — the business's products and retailers, created and maintained here
// so a business can be set up without SQL and without a Shopify connection (CONFIG-01a).
// The database enforces pause, the operator grants, duplicates, stale edits, synced-sku
// and fixed-currency protection; this page shows state and collects the change.

import { supabaseServer, orgId } from '@/lib/supabase';
import { CATALOG_OUTCOMES, isCatalogOutcome, isSynced, type ProductRow, type RetailerRow } from '@/lib/catalog';

export const dynamic = 'force-dynamic';

interface Can { products: boolean; retailers: boolean; note: string | null }

async function loadCatalog() {
  const sb = await supabaseServer();
  const org = orgId();
  const [products, retailers, grants, controls] = await Promise.all([
    sb.from('products').select('id, sku, display_name, unit, active, shopify_product_id, shopify_variant_id, updated_at')
      .eq('org_id', org).order('sku').limit(500),
    sb.from('accounts').select('id, name, currency, tax_exempt, payment_terms_days, billing_email, status, updated_at')
      .eq('org_id', org).order('name').limit(500),
    sb.from('tool_grants').select('tool_name, enabled').eq('org_id', org).eq('agent_name', 'operator')
      .in('tool_name', ['catalog.save', 'accounts.save']),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
  ]);
  for (const r of [products, retailers, grants, controls]) if (r.error) throw r.error;
  // Shown so the operator knows before trying; the database enforces pause and the
  // grants on every save.
  const paused = Boolean(controls.data?.paused);
  const granted = (tool: string) => (grants.data ?? []).some(g => g.tool_name === tool && g.enabled);
  const can: Can = {
    products: !paused && granted('catalog.save'),
    retailers: !paused && granted('accounts.save'),
    note: paused ? 'Business actions are paused, so the catalogue cannot be changed until they are resumed.'
      : !granted('catalog.save') || !granted('accounts.save')
        ? 'Some catalogue editing is switched off for this business (an operator grant is missing or revoked); those forms are hidden.' : null,
  };
  return { products: (products.data ?? []) as ProductRow[], retailers: (retailers.data ?? []) as RetailerRow[], can };
}

const field = 'rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm';
const button = 'rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-3 py-1 text-sm font-medium';

export default async function CatalogPage({ searchParams }: { searchParams: Promise<{ outcome?: string }> }) {
  const { outcome } = await searchParams;
  const notice = isCatalogOutcome(outcome) ? CATALOG_OUTCOMES[outcome] : null;
  const { products, retailers, can } = await loadCatalog();

  return (
    <div className="space-y-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Catalogue</h1>
        <div className="text-sm text-zinc-500">{products.length} products · {retailers.length} retailers</div>
      </div>

      {notice ? (
        <div data-testid="catalog-notice" role="status" className={`rounded-lg border p-4 text-sm ${notice.ok
          ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
          : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'}`}>
          {notice.text}
        </div>
      ) : null}

      {can.note ? (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 text-sm text-zinc-600 dark:text-zinc-400">{can.note}</div>
      ) : null}

      <section className="space-y-3" aria-label="Products">
        <h2 className="text-lg font-semibold">Products</h2>
        {can.products ? (
          <form method="post" action="/catalog/product" className="flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
            <label className="text-sm">SKU<br /><input name="sku" aria-label="New product SKU" required maxLength={64} className={field} /></label>
            <label className="text-sm">Name<br /><input name="display_name" aria-label="New product name" required maxLength={200} className={field} /></label>
            <label className="text-sm">Unit<br /><input name="unit" aria-label="New product unit" defaultValue="each" required maxLength={32} className={`${field} w-20`} /></label>
            <label className="text-sm flex items-center gap-1 pb-1"><input type="checkbox" name="active" defaultChecked /> Active</label>
            <button type="submit" className={button}>Add product</button>
          </form>
        ) : null}
        {products.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center text-zinc-500">
            No products yet. Add the first one above, or connect Shopify and let the sync bring them in.
          </div>
        ) : (
          products.map(row => (
            <div key={row.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4" data-testid="product">
              <form method="post" action="/catalog/product" className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="product_id" value={row.id} />
                <input type="hidden" name="expected_updated_at" value={row.updated_at} />
                <label className="text-sm">SKU<br />
                  <input name="sku" aria-label={`SKU of ${row.sku}`} defaultValue={row.sku} readOnly={isSynced(row)} required maxLength={64}
                    className={`${field} font-mono ${isSynced(row) ? 'opacity-60' : ''}`} /></label>
                <label className="text-sm">Name<br /><input name="display_name" aria-label={`Name of ${row.sku}`} defaultValue={row.display_name} required maxLength={200} className={`${field} w-64`} /></label>
                <label className="text-sm">Unit<br /><input name="unit" aria-label={`Unit of ${row.sku}`} defaultValue={row.unit} required maxLength={32} className={`${field} w-20`} /></label>
                <label className="text-sm flex items-center gap-1 pb-1"><input type="checkbox" name="active" defaultChecked={row.active} /> Active</label>
                {can.products ? <button type="submit" className={button}>Save</button> : null}
                <span className="pb-1 text-xs text-zinc-500">
                  {isSynced(row) ? 'Synced from Shopify; the SKU is fixed here.' : 'Created in the console.'}
                  {row.active ? '' : ' Inactive: new work will not match it.'}
                </span>
              </form>
            </div>
          ))
        )}
      </section>

      <section className="space-y-3" aria-label="Retailers">
        <h2 className="text-lg font-semibold">Retailers</h2>
        {can.retailers ? (
          <form method="post" action="/catalog/retailer" className="flex flex-wrap items-end gap-2 rounded-lg border border-zinc-200 dark:border-zinc-800 p-4">
            <label className="text-sm">Name<br /><input name="name" aria-label="New retailer name" required maxLength={200} className={`${field} w-56`} /></label>
            <label className="text-sm">Currency<br /><input name="currency" aria-label="New retailer currency" required maxLength={3} placeholder="NZD" className={`${field} w-16 uppercase`} /></label>
            <label className="text-sm">Terms (days)<br /><input name="payment_terms_days" aria-label="New retailer terms days" type="number" min={0} max={365} defaultValue={14} required className={`${field} w-20`} /></label>
            <label className="text-sm">Billing email<br /><input name="billing_email" aria-label="New retailer billing email" type="email" maxLength={200} className={field} /></label>
            <label className="text-sm flex items-center gap-1 pb-1"><input type="checkbox" name="tax_exempt" /> Tax exempt</label>
            <input type="hidden" name="status" value="active" />
            <button type="submit" className={button}>Add retailer</button>
          </form>
        ) : null}
        {retailers.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center text-zinc-500">
            No retailers yet. Add the first one above; invoices and statements are billed to a retailer.
          </div>
        ) : (
          retailers.map(row => (
            <div key={row.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4" data-testid="retailer">
              <form method="post" action="/catalog/retailer" className="flex flex-wrap items-end gap-2">
                <input type="hidden" name="account_id" value={row.id} />
                <input type="hidden" name="expected_updated_at" value={row.updated_at} />
                <label className="text-sm">Name<br /><input name="name" aria-label={`Name of retailer ${row.name}`} defaultValue={row.name} required maxLength={200} className={`${field} w-56`} /></label>
                <label className="text-sm">Currency<br /><input name="currency" aria-label={`Currency of ${row.name}`} defaultValue={row.currency} required maxLength={3} className={`${field} w-16 uppercase`} /></label>
                <label className="text-sm">Terms (days)<br /><input name="payment_terms_days" aria-label={`Terms days of ${row.name}`} type="number" min={0} max={365} defaultValue={row.payment_terms_days} required className={`${field} w-20`} /></label>
                <label className="text-sm">Billing email<br /><input name="billing_email" aria-label={`Billing email of ${row.name}`} type="email" defaultValue={row.billing_email ?? ''} maxLength={200} className={field} /></label>
                <label className="text-sm">Status<br />
                  <select name="status" aria-label={`Status of ${row.name}`} defaultValue={row.status} className={field}>
                    <option value="active">active</option><option value="dormant">dormant</option><option value="closed">closed</option>
                  </select></label>
                <label className="text-sm flex items-center gap-1 pb-1"><input type="checkbox" name="tax_exempt" defaultChecked={row.tax_exempt} /> Tax exempt</label>
                {can.retailers ? <button type="submit" className={button}>Save</button> : null}
              </form>
            </div>
          ))
        )}
      </section>
    </div>
  );
}
