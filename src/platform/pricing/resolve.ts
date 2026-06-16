// Pricing resolver — Phase 1 PR-D. Looks up the unit price for a (account, product) pair
// by walking account_price_books → price_book_entries, falling back to the org-default
// price_book when no account binding exists.
//
// The resolver is structured as a pure picker (`pickPriceBook`, `pickEntry`) wrapped by
// the IO function `resolvePricesForAccount`. The pure parts are testable in isolation
// without the supabase client.

import { supabase, orgId } from '../../data/supabase.js';
import type {
  AccountPriceBookBinding,
  PriceBook,
  PriceBookEntry,
  ResolvedPrice,
} from './types.js';

/**
 * Choose the active price book for an account.
 *
 *   1. Latest account_price_books binding by effective_from (if any binding has
 *      effective_from <= now).
 *   2. Org-default price book (`is_default = true and active = true`).
 *   3. null — no resolvable book.
 *
 * Pure function: no IO, deterministic for given inputs.
 */
export function pickPriceBook(args: {
  bindings: AccountPriceBookBinding[];
  books: PriceBook[];
  now: Date;
}): { book: PriceBook; source: 'account_binding' | 'default_book' } | null {
  const { bindings, books, now } = args;
  const bookById = new Map(books.map((b) => [b.id, b]));

  const effective = bindings
    .filter((b) => new Date(b.effectiveFrom).getTime() <= now.getTime())
    .sort(
      (a, b) =>
        new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime(),
    );

  for (const binding of effective) {
    const book = bookById.get(binding.priceBookId);
    if (book && book.active) {
      return { book, source: 'account_binding' };
    }
  }

  const fallback = books.find((b) => b.isDefault && b.active);
  if (fallback) {
    return { book: fallback, source: 'default_book' };
  }
  return null;
}

/**
 * Find the price_book_entries row for (priceBookId, productId). Returns null if there's
 * no row — the caller decides whether that's an error or a fallthrough.
 */
export function pickEntry(args: {
  entries: PriceBookEntry[];
  priceBookId: string;
  productId: string;
}): PriceBookEntry | null {
  return (
    args.entries.find(
      (e) => e.priceBookId === args.priceBookId && e.productId === args.productId,
    ) ?? null
  );
}

/**
 * Resolve unit prices for a list of products against an account. The caller passes the
 * full product id list; the result is one ResolvedPrice per product that resolved, plus
 * a `missing` list for products with no entry in the chosen book. The caller (typically
 * the draft_invoice tool) decides what to do with `missing` — for v1 wholesale it raises
 * because we expect every shipped product to be priced.
 */
export async function resolvePricesForAccount(args: {
  accountId: string;
  productIds: string[];
  now?: Date;
}): Promise<{ resolved: ResolvedPrice[]; missing: string[] }> {
  const sb = supabase();
  const now = args.now ?? new Date();
  const ids = Array.from(new Set(args.productIds));
  if (ids.length === 0) return { resolved: [], missing: [] };

  const [bindingsRes, booksRes] = await Promise.all([
    sb
      .from('account_price_books')
      .select('account_id, price_book_id, effective_from')
      .eq('account_id', args.accountId),
    sb
      .from('price_books')
      .select('id, currency, is_default, active')
      .eq('org_id', orgId()),
  ]);
  if (bindingsRes.error) throw bindingsRes.error;
  if (booksRes.error) throw booksRes.error;

  const bindings: AccountPriceBookBinding[] = (bindingsRes.data ?? []).map((r) => ({
    accountId: r.account_id as string,
    priceBookId: r.price_book_id as string,
    effectiveFrom: r.effective_from as string,
  }));
  const books: PriceBook[] = (booksRes.data ?? []).map((r) => ({
    id: r.id as string,
    currency: r.currency as string,
    isDefault: r.is_default as boolean,
    active: r.active as boolean,
  }));

  const pick = pickPriceBook({ bindings, books, now });
  if (!pick) {
    throw new Error(
      `pricing: no active price book for account ${args.accountId} ` +
        `(no binding, no org-default)`,
    );
  }

  const { data: entriesData, error: entriesErr } = await sb
    .from('price_book_entries')
    .select('price_book_id, product_id, unit_price_cents')
    .eq('org_id', orgId())
    .eq('price_book_id', pick.book.id)
    .in('product_id', ids);
  if (entriesErr) throw entriesErr;
  const entries: PriceBookEntry[] = (entriesData ?? []).map((r) => ({
    priceBookId: r.price_book_id as string,
    productId: r.product_id as string,
    unitPriceCents: Number(r.unit_price_cents),
  }));

  const resolved: ResolvedPrice[] = [];
  const missing: string[] = [];
  for (const productId of ids) {
    const entry = pickEntry({ entries, priceBookId: pick.book.id, productId });
    if (!entry) {
      missing.push(productId);
      continue;
    }
    resolved.push({
      productId,
      unitPriceCents: entry.unitPriceCents,
      currency: pick.book.currency,
      priceBookId: pick.book.id,
      source: pick.source,
    });
  }

  return { resolved, missing };
}
