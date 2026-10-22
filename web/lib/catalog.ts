// Console catalogue (0040): list row shapes and the fixed outcome map for saving
// products and retailers. The database owns every rule (grants, pause, duplicates,
// stale edits, synced-sku and fixed-currency protection); this module only maps its
// refusals to fixed operator-facing outcomes — raw errors never reach the browser.

export interface ProductRow {
  id: string; sku: string; display_name: string; unit: string; active: boolean;
  shopify_product_id: string | null; shopify_variant_id: string | null; updated_at: string;
}
export interface RetailerRow {
  id: string; name: string; currency: string; tax_exempt: boolean; payment_terms_days: number;
  billing_email: string | null; status: string; updated_at: string;
}

/** A synced product's sku is its source identity; the console says so instead of letting
 * an edit be refused as a surprise. */
export const isSynced = (row: Pick<ProductRow, 'shopify_product_id' | 'shopify_variant_id'>) =>
  row.shopify_product_id !== null || row.shopify_variant_id !== null;

export const CATALOG_OUTCOMES = {
  product_saved: { ok: true, text: 'Product saved.' },
  retailer_saved: { ok: true, text: 'Retailer saved.' },
  duplicate_sku: { ok: false, text: 'A product with that SKU already exists for this business. Nothing changed.' },
  duplicate_name: { ok: false, text: 'A retailer with that name already exists for this business. Nothing changed.' },
  stale: { ok: false, text: 'This record changed since the page was loaded. Nothing changed; reload and edit the current version.' },
  synced_sku: { ok: false, text: 'This product is synced from Shopify, so its SKU is fixed here; its other fields stay editable. Nothing changed.' },
  currency_fixed: { ok: false, text: 'This retailer already has invoices, so its currency is fixed. Nothing changed; save again without changing the currency.' },
  invalid: { ok: false, text: 'Check the fields: SKU and names are required, the currency is a 3-letter code, terms are 0-365 days and the billing email must be an address. Nothing changed.' },
  not_allowed: { ok: false, text: 'Catalogue editing is switched off for this business (its operator grant is missing or revoked). Nothing changed.' },
  paused: { ok: false, text: 'Business actions are paused, so nothing changed. Resume them first.' },
  not_found: { ok: false, text: 'That record no longer exists for this business. Nothing changed.' },
  failed: { ok: false, text: 'The change could not be saved. Nothing changed; try again.' },
} as const;
export type CatalogOutcome = keyof typeof CATALOG_OUTCOMES;

const SAVE_ERRORS: Array<[RegExp, CatalogOutcome]> = [
  [/business actions paused/, 'paused'],
  [/tool entitlement missing or revoked|must not require approval|agent disabled/, 'not_allowed'],
  [/sku already exists/, 'duplicate_sku'],
  [/retailer name already exists/, 'duplicate_name'],
  [/changed since it was loaded/, 'stale'],
  [/synced product sku is fixed/, 'synced_sku'],
  [/currency is fixed once it has invoices/, 'currency_fixed'],
  [/fields required|field too long|3-letter code|out of range|unknown retailer status|billing email invalid|operator identity required/, 'invalid'],
  [/not found/i, 'not_found'],
];
export function catalogOutcomeFor(errorMessage: string): CatalogOutcome {
  return SAVE_ERRORS.find(([pattern]) => pattern.test(errorMessage))?.[1] ?? 'failed';
}
export function isCatalogOutcome(value: unknown): value is CatalogOutcome {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CATALOG_OUTCOMES, value);
}
