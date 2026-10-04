import { z } from 'zod';

// Exact decimal strings at storage/action boundaries; bigint only during calculation.
const money = z.string().regex(/^(0|[1-9][0-9]*)$/).refine(v => BigInt(v) <= 9223372036854775807n, 'money exceeds bigint');
const id = z.string().trim().min(1);
const instant = z.string().datetime({ offset: true });
const quantity = z.number().int().positive().max(2147483647);
const scope = { accountId: id.nullable(), productId: id };
const override = z.object({ amount: money, actor: id, reason: id }).strict();
const discount = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('percent'), bps: z.number().int().min(0).max(10000) }).strict(),
  z.object({ kind: z.literal('fixed'), amount: money }).strict(),
]);
const shippingMode = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('actual') }).strict(),
  z.object({ kind: z.literal('adjusted'), fixed: money, markupBps: z.number().int().min(0).max(10000) }).strict(),
  z.object({ kind: z.literal('fixed'), amount: money }).strict(),
  z.object({ kind: z.literal('free') }).strict(),
  z.object({ kind: z.literal('manual') }).strict(),
]);
export const PricingConfigSchema = z.object({
  schemaVersion: z.literal(1), businessId: id, version: id, name: id,
  currency: z.enum(['NZD','AUD','USD','EUR','GBP','CAD']), scale: z.literal(2), taxBasis: z.literal('exclusive'),
  taxRateBps: z.number().int().min(0).max(10000), freightTaxable: z.boolean(),
  effectiveFrom: instant, effectiveUntil: instant.nullable(), timezone: id,
  pricingDateBasis: z.enum(['order', 'dispatch']), tierQuantityBasis: z.enum(['ordered', 'dispatched']),
  fallback: z.enum(['default_book', 'none']),
  // Explicit precedence selects one price. Discounts are applied afterwards only if configured.
  pricePrecedence: z.array(z.enum(['negotiated', 'tier', 'book'])).length(3),
  discountCombination: z.enum(['single', 'sequential']), discountOnSpecialPrice: z.boolean(),
  books: z.array(z.object({ id, isDefault: z.boolean(), entries: z.array(z.object({ productId: id, unitPrice: money }).strict()).min(1) }).strict()).min(1),
  bindings: z.array(z.object({ accountId: id, bookId: id }).strict()),
  negotiated: z.array(z.object({ ...scope, id, unitPrice: money }).strict()),
  tiers: z.array(z.object({ ...scope, id, minimum: quantity, unitPrice: money }).strict()),
  discounts: z.array(z.object({ ...scope, id, order: z.number().int().nonnegative(), discount }).strict()),
  shipping: z.object({ enabled: z.boolean(), rules: z.array(z.object({
    id, accountId: id.nullable(), destination: id.nullable(), priority: z.number().int(), mode: shippingMode,
    chargingBasis: z.enum(['per_dispatch', 'order_schedule']),
    freeThreshold: z.object({ amount: money, valueBasis: z.enum(['order', 'dispatch']), afterDiscount: z.boolean(), includesTax: z.boolean() }).strict().nullable(),
  }).strict()) }).strict(),
}).strict().superRefine((v, ctx) => {
  const fail = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (v.effectiveUntil && Date.parse(v.effectiveUntil) <= Date.parse(v.effectiveFrom)) fail('invalid effective interval');
  try { new Intl.DateTimeFormat('en', { timeZone: v.timezone }); } catch { fail('invalid timezone'); }
  const unique = (values: string[], label: string) => { if (new Set(values).size !== values.length) fail(`duplicate ${label}`); };
  unique(v.pricePrecedence, 'precedence'); unique(v.books.map(b => b.id), 'book');
  for (const b of v.books) unique(b.entries.map(e => e.productId), 'product mapping');
  unique(v.bindings.map(b => b.accountId), 'retailer binding');
  if (v.books.filter(b => b.isDefault).length > 1) fail('conflicting default books');
  if (v.bindings.some(b => !v.books.some(book => book.id === b.bookId))) fail('unknown price book');
  unique([...v.negotiated, ...v.tiers, ...v.discounts].map(r => r.id), 'product rule identity');
  unique(v.shipping.rules.map(r => r.id), 'shipping rule identity');
  if (!v.shipping.enabled && v.shipping.rules.length) fail('disabled shipping cannot have active rules');
});
export type PricingConfig = z.infer<typeof PricingConfigSchema>;

export const PricingInputSchema = z.object({
  businessId: id, accountId: id, orderKey: id, dispatchKey: id.nullable(),
  orderAt: instant, dispatchAt: instant.nullable(), evaluatedAt: instant,
  destination: id.nullable(),
  lines: z.array(z.object({ lineId: id, productId: id, description: id, ordered: quantity, dispatched: quantity, override: override.nullable() }).strict()).min(1),
  carrier: z.object({ businessId: id, connectionId: id, shipmentKey: id, quoteId: id, observedAt: instant, expiresAt: instant, currency: id, taxBasis: z.literal('exclusive'), cost: money }).strict().nullable(),
  freightOverride: override.nullable(),
  freightSchedule: z.object({ id, total: money, allocations: z.array(z.object({ dispatchKey: id, amount: money }).strict()).min(1) }).strict().nullable(),
  // Whole-order threshold amounts must come from an authoritative pricing preview.
  orderValue: z.object({ beforeDiscount: money, afterDiscount: money }).strict().nullable(),
  terms: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('explicit'), dueDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), actor: id, reason: id }).strict(),
    z.object({ kind: z.literal('following_month_day'), day: z.number().int().min(1).max(28), anchor: z.enum(['invoice', 'dispatch']), invoiceAt: instant }).strict(),
  ]),
}).strict();
export type PricingInput = z.infer<typeof PricingInputSchema>;
const amount = (v: bigint): string => {
  if (v < 0n || v > 9223372036854775807n) throw new Error('pricing: amount outside supported range');
  return v.toString();
};
const tax = (v: bigint, bps: number) => v * BigInt(bps) / 10000n;
function one<T>(values: T[], label: string): T | undefined {
  if (values.length > 1) throw new Error(`pricing: conflicting ${label}`);
  return values[0];
}
function localDate(timestamp: string, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(new Date(timestamp));
  return ['year', 'month', 'day'].map(k => parts.find(p => p.type === k)!.value).join('-');
}

/** Shared implementation for explained preview and invoice snapshots. No IO or provider assumptions. */
export function calculatePricing(rawConfig: unknown, rawInput: unknown) {
  const config = PricingConfigSchema.parse(rawConfig);
  const input = PricingInputSchema.parse(rawInput);
  if (input.businessId !== config.businessId) throw new Error('pricing: wrong business');
  if (new Set(input.lines.map(l => l.lineId)).size !== input.lines.length) throw new Error('pricing: duplicate line identity');
  const pricingAt = config.pricingDateBasis === 'order' ? input.orderAt : input.dispatchAt;
  if (!pricingAt) throw new Error('pricing: dispatch date required');
  if (Date.parse(pricingAt) < Date.parse(config.effectiveFrom) || (config.effectiveUntil && Date.parse(pricingAt) >= Date.parse(config.effectiveUntil))) throw new Error('pricing: configuration not effective');
  const binding = config.bindings.find(b => b.accountId === input.accountId);
  const book = binding ? config.books.find(b => b.id === binding.bookId) : config.fallback === 'default_book' ? config.books.find(b => b.isDefault) : undefined;
  if (!book) throw new Error('pricing: retailer has no price book');
  const lines = input.lines.map(line => {
    if (line.dispatched > line.ordered) throw new Error('pricing: quantity exceeds order');
    const matches = (r: { accountId: string | null; productId: string }) => r.productId === line.productId && (r.accountId === null || r.accountId === input.accountId);
    const entry = book.entries.find(e => e.productId === line.productId);
    if (!entry) throw new Error(`pricing: missing product ${line.productId}`);
    const negotiated = one(config.negotiated.filter(matches), 'negotiated prices');
    const eligible = config.tiers.filter(r => matches(r) && r.minimum <= (config.tierQuantityBasis === 'ordered' ? line.ordered : line.dispatched));
    const highest = Math.max(0, ...eligible.map(r => r.minimum));
    const tier = one(eligible.filter(r => r.minimum === highest), 'quantity tiers');
    const candidates = { negotiated, tier, book: { id: book.id, unitPrice: entry.unitPrice } };
    const kind = config.pricePrecedence.find(k => candidates[k])!;
    const selected = candidates[kind]!;
    let unit = BigInt(selected.unitPrice);
    const discounts = config.discounts.filter(matches).sort((a,b) => a.order - b.order);
    if (discounts.length > 1 && (config.discountCombination === 'single' || new Set(discounts.map(d => d.order)).size !== discounts.length)) throw new Error('pricing: conflicting discount order/combination');
    const applied = kind === 'book' || config.discountOnSpecialPrice ? discounts : [];
    for (const rule of applied) {
      const reduction = rule.discount.kind === 'fixed' ? BigInt(rule.discount.amount) : tax(unit, rule.discount.bps);
      if (reduction > unit) throw new Error('pricing: discount exceeds price');
      unit -= reduction;
    }
    const beforeOverride = unit;
    if (line.override) unit = BigInt(line.override.amount);
    return { ...line, bookId: book.id, baseUnitPrice: entry.unitPrice, selectedRule: selected.id, selectedKind: kind,
      beforeDiscountUnitPrice: selected.unitPrice, beforeOverrideUnitPrice: amount(beforeOverride),
      discountPerUnit: amount(BigInt(selected.unitPrice)-beforeOverride), overrideDelta: (unit-beforeOverride).toString(),
      discountRules: applied.map(r => r.id), unitPrice: amount(unit),
      lineAmount: amount(unit * BigInt(line.dispatched)), explanation: `${kind} ${selected.id}; tier basis ${config.tierQuantityBasis}; discounts ${applied.map(r => r.id).join(', ') || 'none'}${line.override ? '; reasoned override' : ''}` };
  });
  const subtotal = lines.reduce((n,l) => n + BigInt(l.lineAmount), 0n);
  let freight = 0n;
  let shippingRule: string | null = null;
  let shippingBasis: 'disabled' | 'per_dispatch' | 'order_schedule' = 'disabled';
  let freightExplanation = 'Shipping capability disabled';
  if (!config.shipping.enabled && (input.carrier || input.freightOverride || input.freightSchedule)) throw new Error('pricing: shipping inputs supplied to disabled capability');
  if (config.shipping.enabled) {
    if (!input.dispatchKey) throw new Error('pricing: shipping requires dispatch identity');
    const rules = config.shipping.rules.filter(r => (r.accountId === null || r.accountId === input.accountId) && (r.destination === null || r.destination === input.destination));
    const priority = Math.max(...rules.map(r => r.priority));
    const rule = one(rules.filter(r => r.priority === priority), 'shipping rules');
    if (!rule) throw new Error('pricing: shipping rule missing');
    shippingRule = rule.id; shippingBasis = rule.chargingBasis;
    const carrier = input.carrier;
    if (carrier && (carrier.businessId !== input.businessId || carrier.shipmentKey !== input.dispatchKey || carrier.currency !== config.currency || Date.parse(carrier.observedAt) > Date.parse(input.evaluatedAt))) throw new Error('pricing: invalid carrier evidence binding');
    if (rule.mode.kind === 'actual' || rule.mode.kind === 'adjusted') {
      if (!carrier || Date.parse(carrier.expiresAt) <= Date.parse(input.evaluatedAt)) throw new Error('pricing: missing or expired carrier quote');
      freight = BigInt(carrier.cost);
      if (rule.mode.kind === 'adjusted') freight += BigInt(rule.mode.fixed) + tax(freight, rule.mode.markupBps);
    } else if (rule.mode.kind === 'fixed') freight = BigInt(rule.mode.amount);
    else if (rule.mode.kind === 'manual' && !input.freightOverride) throw new Error('pricing: reasoned freight override required');
    if (rule.freeThreshold) {
      const threshold = rule.freeThreshold;
      let value: bigint;
      if (threshold.valueBasis === 'order') {
        if (!input.orderValue) throw new Error('pricing: whole order value required for threshold');
        value = BigInt(threshold.afterDiscount ? input.orderValue.afterDiscount : input.orderValue.beforeDiscount);
      } else value = threshold.afterDiscount ? subtotal : lines.reduce((n,l) => n + BigInt(l.beforeDiscountUnitPrice) * BigInt(l.dispatched), 0n);
      if (threshold.includesTax) value += tax(value, config.taxRateBps);
      if (value >= BigInt(threshold.amount)) freight = 0n;
    }
    if (input.freightOverride) freight = BigInt(input.freightOverride.amount);
    freightExplanation = `${rule.id}: ${rule.mode.kind}; ${rule.chargingBasis}${input.freightOverride ? '; reasoned override' : ''}`;
    if (rule.chargingBasis === 'order_schedule') {
      const schedule = input.freightSchedule;
      if (!schedule || BigInt(schedule.total) !== freight || new Set(schedule.allocations.map(a => a.dispatchKey)).size !== schedule.allocations.length || schedule.allocations.reduce((n,a) => n + BigInt(a.amount), 0n) !== freight) throw new Error('pricing: invalid freight allocation schedule');
      const allocation = schedule.allocations.find(a => a.dispatchKey === input.dispatchKey);
      if (!allocation) throw new Error('pricing: dispatch absent from freight schedule');
      freight = BigInt(allocation.amount);
    } else if (input.freightSchedule) throw new Error('pricing: unexpected freight schedule');
  }
  const taxAmount = tax(subtotal + (config.freightTaxable ? freight : 0n), config.taxRateBps);
  let dueDate: string;
  if (input.terms.kind === 'explicit') {
    dueDate = input.terms.dueDate;
    if (new Date(dueDate + 'T00:00:00Z').toISOString().slice(0,10) !== dueDate) throw new Error('pricing: invalid due date');
  } else {
    const anchor = input.terms.anchor === 'invoice' ? input.terms.invoiceAt : input.dispatchAt;
    if (!anchor) throw new Error('pricing: terms anchor missing');
    const [year, month] = localDate(anchor, config.timezone).split('-').map(Number);
    dueDate = new Date(Date.UTC(year!, month!, input.terms.day)).toISOString().slice(0,10);
  }
  return { schemaVersion: 1 as const, businessId: config.businessId, configVersion: config.version, currency: config.currency, scale: config.scale,
    taxBasis: config.taxBasis, pricingAt, pricingDateBasis: config.pricingDateBasis, timezone: config.timezone,
    rounding: 'floor_minor_unit_per_discount_then_invoice_tax' as const, input, lines,
    freight: { amount: amount(freight), carrier: input.carrier, ruleId: shippingRule, basis: shippingBasis, schedule: input.freightSchedule, override: input.freightOverride, explanation: freightExplanation },
    tax: { rateBps: config.taxRateBps, freightTaxable: config.freightTaxable, amount: amount(taxAmount) },
    subtotal: amount(subtotal), total: amount(subtotal + freight + taxAmount), terms: { ...input.terms, dueDate },
  };
}
export type PricingSnapshot = ReturnType<typeof calculatePricing>;

export function previewPricing(config: unknown, input: unknown) {
  try { return { status: 'ready' as const, snapshot: calculatePricing(config, input) }; }
  catch (error) { return { status: 'blocked' as const, reason: (error as Error).message }; }
}
