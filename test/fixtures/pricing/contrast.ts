import type { PricingConfig, PricingInput } from '../../../src/platform/pricing/versioned.js';

// PORT-01: a deliberately anti-VICE business shape — USD in New York, 8.75% tax that
// skips freight, order-date pricing, dispatched-quantity tiers, a bindingless default
// book, tier-first precedence, sequential discounts that also cut special prices, fixed
// per-shipment freight waived over a part-value threshold, and terms on the 1st of the
// following month. Every knob VICE leaves at its other setting is set here, and the same
// calculator and SQL boundary must carry both without business-specific code.
export function config(): PricingConfig {
  return { schemaVersion: 1, businessId: 'contrast', version: 'v1', name: 'Synthetic imports (US)', currency: 'USD', scale: 2,
    taxBasis: 'exclusive', taxRateBps: 875, freightTaxable: false, effectiveFrom: '2026-10-01T00:00:00-04:00', effectiveUntil: null,
    timezone: 'America/New_York', pricingDateBasis: 'order', tierQuantityBasis: 'dispatched', fallback: 'default_book',
    pricePrecedence: ['tier', 'negotiated', 'book'], discountCombination: 'sequential', discountOnSpecialPrice: true,
    books: [{ id: 'default-book', isDefault: true, entries: [{ productId: 'gadget', unitPrice: '2000' }] }],
    bindings: [], negotiated: [{ id: 'gadget-deal', accountId: 'importer-a', productId: 'gadget', unitPrice: '1950' }],
    tiers: [{ id: 'volume-25', accountId: null, productId: 'gadget', minimum: 25, unitPrice: '1800' }],
    discounts: [
      { id: 'season-5pct', accountId: null, productId: 'gadget', order: 0, discount: { kind: 'percent', bps: 500 } },
      { id: 'coop-25c', accountId: null, productId: 'gadget', order: 1, discount: { kind: 'fixed', amount: '25' } },
    ],
    shipping: { enabled: true, rules: [{ id: 'flat-ship', accountId: null, destination: null, priority: 0, mode: { kind: 'fixed', amount: '500' },
      chargingBasis: 'per_dispatch', freeThreshold: { amount: '40000', valueBasis: 'dispatch', afterDiscount: true, includesTax: false } }] },
    terms: { kind: 'following_month_day', day: 1, anchor: 'dispatch' } };
}
export function input(): PricingInput {
  return { businessId: 'contrast', accountId: 'importer-a', orderKey: 'order-1', dispatchKey: 'dispatch-p1', orderAt: '2026-10-20T09:00:00-04:00', dispatchAt: '2026-10-22T10:00:00-04:00', evaluatedAt: '2026-10-22T11:00:00-04:00', destination: null,
    lines: [{ lineId: 'line-1', productId: 'gadget', description: 'Synthetic gadget', ordered: 50, dispatched: 30, override: null }],
    carrier: null, freightOverride: null, priorParts: 0, taxExempt: false, orderValue: null,
    terms: { kind: 'following_month_day', anchor: 'dispatch', day: 1, invoiceAt: '2026-10-22T11:00:00-04:00' } };
}
