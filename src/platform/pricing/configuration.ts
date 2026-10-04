import { PricingConfigSchema, type PricingConfig } from './versioned.js';

/** Activation ordering is stored by pricing_activations; caller supplies activated
 * versions only. A newer expired version cannot resurrect an older price book. */
export function selectPricingVersion(versions: unknown[], businessId: string, pricingAt: string): PricingConfig {
  const timestamp = Date.parse(pricingAt);
  if (!Number.isFinite(timestamp)) throw new Error('pricing: valid pricing instant required');
  const parsed = versions.map(v => PricingConfigSchema.parse(v));
  if (parsed.some(v => v.businessId !== businessId)) throw new Error('pricing: cross-business configuration result');
  const eligible = parsed.filter(v => Date.parse(v.effectiveFrom) <= timestamp).sort((a,b) => Date.parse(b.effectiveFrom)-Date.parse(a.effectiveFrom));
  const chosen = eligible[0];
  if (!chosen || (chosen.effectiveUntil && timestamp >= Date.parse(chosen.effectiveUntil))) throw new Error('pricing: no effective configuration');
  if (eligible[1] && Date.parse(eligible[1].effectiveFrom) === Date.parse(chosen.effectiveFrom)) throw new Error('pricing: conflicting active versions');
  return chosen;
}

export interface ImportRow { sourceRow: number; productId: string; unitPrice: string; }
/** Workbook adapters normalize rows into exact IDs/minor-unit strings. Import is a
 * draft diff, never activation, product creation or replacement of retailer deals. */
export function previewPriceImport(rawConfig: unknown, bookId: string, rows: ImportRow[]) {
  const config = PricingConfigSchema.parse(rawConfig);
  const book = config.books.find(b => b.id === bookId);
  if (!book) throw new Error('pricing: import book missing');
  if (new Set(rows.map(r => r.productId)).size !== rows.length) throw new Error('pricing: duplicate imported product mapping');
  const changes = rows.map(row => {
    if (!Number.isSafeInteger(row.sourceRow) || row.sourceRow<1) throw new Error('pricing: source row required');
    const entry = book.entries.find(e => e.productId === row.productId);
    if (!entry) throw new Error(`pricing: unmapped import product ${row.productId}`);
    if (!/^(0|[1-9][0-9]*)$/.test(row.unitPrice) || BigInt(row.unitPrice)>9223372036854775807n) throw new Error('pricing: invalid imported money');
    return { ...row, previous: entry.unitPrice, changed: entry.unitPrice !== row.unitPrice };
  });
  const draft = structuredClone(config);
  const draftBook = draft.books.find(b => b.id === bookId)!;
  for (const row of rows) draftBook.entries.find(e => e.productId === row.productId)!.unitPrice = row.unitPrice;
  return { sourceVersion: config.version, changes, draft: PricingConfigSchema.parse(draft), requiresNewVersion: changes.some(c => c.changed), activated: false as const };
}
