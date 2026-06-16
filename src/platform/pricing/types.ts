// Pricing types shared by the resolver + its callers. Mirrors the price_books /
// price_book_entries schema in 0001_core.sql.

export interface PriceBook {
  id: string;
  currency: string;
  isDefault: boolean;
  active: boolean;
}

export interface AccountPriceBookBinding {
  accountId: string;
  priceBookId: string;
  effectiveFrom: string;             // ISO timestamp
}

export interface PriceBookEntry {
  priceBookId: string;
  productId: string;
  unitPriceCents: number;
}

export interface ResolvedPrice {
  productId: string;
  unitPriceCents: number;
  currency: string;
  priceBookId: string;
  source: 'account_binding' | 'default_book';
}
