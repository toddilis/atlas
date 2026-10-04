import type { PricingConfig, PricingInput } from '../../../src/platform/pricing/versioned.js';

export function config(): PricingConfig {
  return { schemaVersion: 1, businessId: 'wholesale', version: 'v1', name: 'Synthetic wholesale', currency: 'NZD', scale: 2,
    taxBasis: 'exclusive', taxRateBps: 1500, freightTaxable: true, effectiveFrom: '2026-10-01T00:00:00+13:00', effectiveUntil: null,
    timezone: 'Pacific/Auckland', pricingDateBasis: 'order', tierQuantityBasis: 'ordered', fallback: 'none',
    pricePrecedence: ['negotiated', 'tier', 'book'], discountCombination: 'single', discountOnSpecialPrice: false,
    books: [{ id: 'book', isDefault: false, entries: [{ productId: 'widget', unitPrice: '1000' }] }],
    bindings: [{ accountId: 'retailer-a', bookId: 'book' }, { accountId: 'retailer-b', bookId: 'book' }], negotiated: [],
    tiers: [{ id: 'volume-100', accountId: null, productId: 'widget', minimum: 100, unitPrice: '800' }],
    discounts: [{ id: 'retailer-b-10', accountId: 'retailer-b', productId: 'widget', order: 0, discount: { kind: 'percent', bps: 1000 } }],
    shipping: { enabled: true, rules: [{ id: 'freight', accountId: null, destination: null, priority: 0, mode: { kind: 'fixed', amount: '1000' }, chargingBasis: 'order_schedule', freeThreshold: null }] } };
}
export function input(): PricingInput {
  return { businessId: 'wholesale', accountId: 'retailer-a', orderKey: 'order-100', dispatchKey: 'dispatch-a', orderAt: '2026-10-01T09:00:00+13:00', dispatchAt: '2026-10-02T09:00:00+13:00', evaluatedAt: '2026-10-02T10:00:00+13:00', destination: null,
    lines: [{ lineId: 'line-1', productId: 'widget', description: 'Synthetic widget', ordered: 100, dispatched: 40, override: null }],
    carrier: null, freightOverride: null, freightSchedule: { id: 'schedule-1', total: '1000', allocations: [{ dispatchKey: 'dispatch-a', amount: '400' }, { dispatchKey: 'dispatch-b', amount: '600' }] }, orderValue: null,
    terms: { kind: 'following_month_day', anchor: 'dispatch', day: 20, invoiceAt: '2026-10-02T10:00:00+13:00' } };
}

