// Pricing console view model (PRICING-01). Pure functions, no IO: exact money and
// percentage conversion for the editor's inputs, the first-version template, the preview
// input, version status, and the fixed messages for save/activate outcomes.

import type { PricingConfig, PricingInput } from '../../src/platform/pricing/versioned';

/** Dollars as typed ("12.50") to exact minor units ("1250"); null when not an amount. */
export function toMinor(text: string): string | null {
  const m = /^(0|[1-9][0-9]{0,15})(?:\.([0-9]{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  return (BigInt(m[1]!) * 100n + BigInt((m[2] ?? '').padEnd(2, '0') || '0')).toString();
}
/** Minor units ("1250") as dollars ("12.50"). */
export function fromMinor(minor: string): string {
  if (!/^(0|[1-9][0-9]*)$/.test(minor)) return '';
  const v = BigInt(minor);
  return `${v / 100n}.${(v % 100n).toString().padStart(2, '0')}`;
}
/** A percentage as typed ("12.5") to basis points (1250); null when not one. */
export function toBps(text: string): number | null {
  const m = /^(100|[1-9]?[0-9])(?:\.([0-9]{1,2}))?$/.exec(text.trim());
  if (!m) return null;
  const bps = Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
  return bps <= 10000 ? bps : null;
}
export const fromBps = (bps: number | null | undefined) =>
  typeof bps === 'number' && Number.isInteger(bps) ? `${Math.floor(bps / 100)}${bps % 100 ? `.${String(bps % 100).padStart(2, '0').replace(/0$/, '')}` : ''}` : '';

export interface ProductOption { id: string; sku: string; name: string }
export interface AccountOption { id: string; name: string; taxExempt: boolean }

/** A business's first version. Every choice that changes what a retailer pays starts
 * empty, so nothing is priced until the operator sets it; the editor will not save it
 * until the schema accepts every field. One price book lists every active product. */
export function firstVersionTemplate(businessId: string, products: ProductOption[]): PricingConfig {
  return {
    schemaVersion: 1, businessId, version: 'v1', name: '',
    currency: null, scale: 2, taxBasis: 'exclusive', taxRateBps: null, freightTaxable: null,
    effectiveFrom: '', effectiveUntil: null, timezone: '',
    pricingDateBasis: null, tierQuantityBasis: null, fallback: null,
    pricePrecedence: ['negotiated', 'tier', 'book'], discountCombination: null, discountOnSpecialPrice: null,
    books: [{ id: 'standard', isDefault: true, entries: products.map(p => ({ productId: p.id, unitPrice: '' })) }],
    bindings: [], negotiated: [], tiers: [], discounts: [],
    shipping: { enabled: false, rules: [] },
    terms: { kind: 'following_month_day', day: null, anchor: null },
  } as unknown as PricingConfig;
}

/** The next version: the latest saved one with a new identifier. Its start is left empty,
 * since a version activates only if it starts after the one in effect. */
export function nextVersionDraft(latest: PricingConfig, latestRevision: number): PricingConfig {
  return { ...structuredClone(latest), version: `v${latestRevision + 1}`, effectiveFrom: '' };
}

/** An effective time as the business reads it: in the version's own timezone, with the year. */
export function formatInZone(iso: string | null, timezone: string): string {
  if (!iso || Number.isNaN(Date.parse(iso))) return '—';
  try {
    return new Intl.DateTimeFormat('en-NZ', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: timezone, timeZoneName: 'short' }).format(Date.parse(iso));
  } catch { return iso; }
}

export interface PreviewRequest {
  accountId: string; taxExempt: boolean; orderAt: string; dispatchAt: string; destination: string;
  lines: Array<{ productId: string; description: string; ordered: number; dispatched: number }>;
  carrierCost: string | null; priorParts: number;
}
/** The calculator input for an operator's preview: a hypothetical order of the chosen
 * retailer, invoiced now. A carrier cost, when given, stands in for stored evidence. */
export function previewInput(config: PricingConfig, request: PreviewRequest, now: Date): PricingInput {
  const at = now.toISOString();
  return {
    businessId: config.businessId, accountId: request.accountId, orderKey: 'preview-order', dispatchKey: 'preview-dispatch',
    orderAt: request.orderAt, dispatchAt: request.dispatchAt || null, evaluatedAt: at, destination: request.destination.trim() || null,
    lines: request.lines.map((l, i) => ({ lineId: `line-${i + 1}`, productId: l.productId, description: l.description,
      ordered: l.ordered, dispatched: l.dispatched, override: null })),
    carrier: request.carrierCost === null ? null : { businessId: config.businessId, connectionId: 'preview', shipmentKey: 'preview-dispatch',
      quoteId: 'preview', observedAt: at, expiresAt: new Date(now.getTime() + 86_400_000).toISOString(),
      currency: config.currency, taxBasis: 'exclusive', cost: request.carrierCost },
    freightOverride: null, priorParts: request.priorParts, taxExempt: request.taxExempt, orderValue: null,
    terms: { kind: 'following_month_day', day: config.terms?.day, anchor: config.terms?.anchor, invoiceAt: at },
  } as PricingInput;
}

export interface VersionRow { id: string; revision: number; version_key: string; config: PricingConfig; actor: string; reason: string; created_at: string }
export interface ActivationRow { version_id: string; actor: string; reason: string; created_at: string }
export type VersionStatus = 'active' | 'scheduled' | 'superseded' | 'expired' | 'saved';

/** Each version's place in the timeline: of the activated versions, the latest that has
 * started is active (until its own end), later ones are scheduled, earlier ones superseded. */
export function versionStatuses(versions: VersionRow[], activations: ActivationRow[], now: Date): Map<string, VersionStatus> {
  const activated = new Set(activations.map(a => a.version_id));
  const started = versions.filter(v => activated.has(v.id) && Date.parse(v.config.effectiveFrom) <= now.getTime())
    .sort((a, b) => Date.parse(b.config.effectiveFrom) - Date.parse(a.config.effectiveFrom));
  const current = started[0];
  return new Map(versions.map(v => {
    if (!activated.has(v.id)) return [v.id, 'saved'];
    if (Date.parse(v.config.effectiveFrom) > now.getTime()) return [v.id, 'scheduled'];
    if (v.id !== current?.id) return [v.id, 'superseded'];
    return [v.id, v.config.effectiveUntil && Date.parse(v.config.effectiveUntil) <= now.getTime() ? 'expired' : 'active'];
  }));
}

/** Outcome codes of the console's pricing actions. Only these fixed messages reach the
 * browser, plus the schema's own field messages for a draft it refuses. */
export const PRICING_OUTCOMES = {
  saved: 'Saved as a new version. Preview it, then activate it when it is right.',
  activated: 'Version activated. Invoices already drafted keep their own snapshots.',
  invalid: 'The draft is not complete or not valid yet. Fix the fields listed below; nothing was saved.',
  stale: 'Someone saved a newer version since this page loaded, so nothing was saved. Your edits are still here; reload the page in another tab to compare before saving again.',
  version_taken: 'A version with this identifier already exists. Choose a new version identifier; nothing was saved.',
  stale_activation: 'This is no longer the latest saved version, so it was not activated. Reload the page to see the latest one.',
  timeline: 'This version does not start after the active version, so it was not activated. Save a new version with a later "effective from" date.',
  preview_changed: 'The saved version no longer produces the preview you checked, so it was not activated. Preview it again first.',
  unknown_reference: 'The version names a product or retailer this business does not have, so nothing was saved.',
  paused: 'Business actions are paused, so nothing changed. Resume them first.',
  not_allowed: 'This action is switched off for this business (its operator grant is missing or revoked). Nothing changed.',
  reason: 'Give a short reason (at least 3 characters). Nothing changed.',
  failed: 'The action could not be recorded. Nothing changed; try again.',
} as const;
export type PricingOutcome = keyof typeof PRICING_OUTCOMES;

const ERRORS: Array<[RegExp, PricingOutcome]> = [
  [/stale pricing revision/, 'stale'],
  [/pricing retry conflicts with stored version|pricing_versions_org_id_version_key_key/, 'version_taken'],
  [/stale pricing activation/, 'stale_activation'],
  [/must advance effective timeline/, 'timeline'],
  [/this business does not have/, 'unknown_reference'],
  [/business actions paused/, 'paused'],
  [/tool entitlement missing or revoked|agent disabled/, 'not_allowed'],
  [/reason required/, 'reason'],
];
export const pricingOutcomeFor = (message: string): PricingOutcome => ERRORS.find(([p]) => p.test(message))?.[1] ?? 'failed';

/** Field labels for the schema's messages, by the first segments of the issue path. */
export function issueLabel(path: Array<string | number>): string {
  const [head, i, field, j, leaf] = path;
  const n = typeof i === 'number' ? ` ${i + 1}` : '';
  switch (head) {
    case 'books': return field === 'entries' ? `Price book${n}, product ${typeof j === 'number' ? j + 1 : ''}${leaf ? ` (${String(leaf)})` : ''}` : `Price book${n}${field ? ` (${String(field)})` : ''}`;
    case 'bindings': return `Retailer price book${n}`;
    case 'negotiated': return `Negotiated price${n}`;
    case 'tiers': return `Volume tier${n}`;
    case 'discounts': return `Discount${n}`;
    case 'shipping': return field === undefined ? 'Shipping' : `Shipping rule ${typeof field === 'number' ? field + 1 : ''}`;
    case 'terms': return 'Payment terms';
    case undefined: return 'Version';
    default: return ({ name: 'Version name', version: 'Version identifier', currency: 'Currency', taxRateBps: 'Tax rate',
      freightTaxable: 'Freight taxable', effectiveFrom: 'Effective from', effectiveUntil: 'Effective until', timezone: 'Timezone',
      pricingDateBasis: 'Pricing date', tierQuantityBasis: 'Volume tier quantity', fallback: 'Retailers without a price book',
      pricePrecedence: 'Price precedence', discountCombination: 'Discount combination', discountOnSpecialPrice: 'Discounts on special prices',
    } as Record<string, string>)[String(head)] ?? String(head);
  }
}
