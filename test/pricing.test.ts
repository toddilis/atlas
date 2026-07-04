// Pricing-resolver unit tests — pure picker functions only. The IO wrapper
// (resolvePricesForAccount) hits the DB, so its behaviour is verified in the live-Supabase
// suite.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pickPriceBook, pickEntry } from '../src/platform/pricing/resolve.js';
import type { PriceBook, AccountPriceBookBinding } from '../src/platform/pricing/types.js';

function book(over: Partial<PriceBook> & { id: string }): PriceBook {
  return { currency: 'NZD', isDefault: false, active: true, ...over };
}

function binding(over: { priceBookId: string; effectiveFrom: string }): AccountPriceBookBinding {
  return { accountId: 'acc-1', ...over };
}

test('pickPriceBook — single active binding wins', () => {
  const result = pickPriceBook({
    bindings: [binding({ priceBookId: 'pb-1', effectiveFrom: '2025-01-01T00:00:00Z' })],
    books: [book({ id: 'pb-1' }), book({ id: 'pb-default', isDefault: true })],
    now: new Date('2025-06-01T00:00:00Z'),
  });
  assert.equal(result?.book.id, 'pb-1');
  assert.equal(result?.source, 'account_binding');
});

test('pickPriceBook — latest effective binding wins when multiple are active', () => {
  const result = pickPriceBook({
    bindings: [
      binding({ priceBookId: 'pb-old', effectiveFrom: '2024-01-01T00:00:00Z' }),
      binding({ priceBookId: 'pb-new', effectiveFrom: '2025-01-01T00:00:00Z' }),
    ],
    books: [book({ id: 'pb-old' }), book({ id: 'pb-new' })],
    now: new Date('2025-06-01T00:00:00Z'),
  });
  assert.equal(result?.book.id, 'pb-new');
});

test('pickPriceBook — future binding is ignored', () => {
  const result = pickPriceBook({
    bindings: [
      binding({ priceBookId: 'pb-future', effectiveFrom: '2030-01-01T00:00:00Z' }),
    ],
    books: [book({ id: 'pb-future' }), book({ id: 'pb-default', isDefault: true })],
    now: new Date('2025-06-01T00:00:00Z'),
  });
  assert.equal(result?.book.id, 'pb-default');
  assert.equal(result?.source, 'default_book');
});

test('pickPriceBook — inactive bound book falls through to default', () => {
  const result = pickPriceBook({
    bindings: [binding({ priceBookId: 'pb-disabled', effectiveFrom: '2025-01-01T00:00:00Z' })],
    books: [
      book({ id: 'pb-disabled', active: false }),
      book({ id: 'pb-default', isDefault: true }),
    ],
    now: new Date('2025-06-01T00:00:00Z'),
  });
  assert.equal(result?.book.id, 'pb-default');
  assert.equal(result?.source, 'default_book');
});

test('pickPriceBook — no binding and no default returns null', () => {
  const result = pickPriceBook({
    bindings: [],
    books: [book({ id: 'pb-other' })],
    now: new Date('2025-06-01T00:00:00Z'),
  });
  assert.equal(result, null);
});

test('pickEntry — returns the matching row', () => {
  const entry = pickEntry({
    entries: [
      { priceBookId: 'pb-1', productId: 'p-a', unitPriceCents: 1000 },
      { priceBookId: 'pb-1', productId: 'p-b', unitPriceCents: 2000 },
      { priceBookId: 'pb-2', productId: 'p-a', unitPriceCents: 9000 },
    ],
    priceBookId: 'pb-1',
    productId: 'p-b',
  });
  assert.equal(entry?.unitPriceCents, 2000);
});

test('pickEntry — returns null when no match', () => {
  const entry = pickEntry({
    entries: [{ priceBookId: 'pb-1', productId: 'p-a', unitPriceCents: 1000 }],
    priceBookId: 'pb-1',
    productId: 'p-missing',
  });
  assert.equal(entry, null);
});
