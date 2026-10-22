import { PricingConfigSchema } from './versioned.js';

export { selectPricingVersion } from './versioned.js';

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
