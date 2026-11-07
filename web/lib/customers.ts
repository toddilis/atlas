// Shopify customers and who Atlas invoices (CONFIG-01d, 0054). Pure: the decision token,
// display names, retailer suggestions, grouping held shipments by customer, and the fixed
// outcome map. The database owns the rules (grant, pause, identity, open same-business
// retailer, reasons, stale edits, releasing held shipments, audit); a suggestion only
// pre-selects a retailer the operator still has to confirm.

export type Decision = 'retailer' | 'not_invoiced' | 'undecided';

export interface CustomerRow {
  id: string; shopify_customer_id: string; email: string | null; first_name: string | null; last_name: string | null;
  company: string | null; tags: string[] | null; account_id: string | null; do_not_invoice: boolean;
  decision_note: string | null; decided_at: string | null; decided_by: string | null;
}
export interface RetailerOption { id: string; name: string; billing_email: string | null }
export interface HeldShipment {
  id: string; occurred_at: string;
  order: { shopify_order_name: string | null; shopify_customer_id: string | null; financial_status: string | null; total_cents: number | string | null; currency: string | null } | null;
}

/** The stale-edit token the database compares (shopify_customer_decision, 0054). */
export function decisionToken(c: Pick<CustomerRow, 'account_id' | 'do_not_invoice'>): string {
  return c.account_id ?? (c.do_not_invoice ? 'not_invoiced' : 'undecided');
}

export function customerName(c: Pick<CustomerRow, 'first_name' | 'last_name' | 'email' | 'shopify_customer_id'>): string {
  const name = [c.first_name, c.last_name].map(v => v?.trim()).filter(Boolean).join(' ');
  return name || c.email?.trim() || `Shopify customer ${c.shopify_customer_id}`;
}

/** Company from the synced default address (raw jsonb), trimmed; null when blank. */
export function companyOf(defaultAddress: unknown): string | null {
  const company = defaultAddress && typeof defaultAddress === 'object' ? (defaultAddress as { company?: unknown }).company : null;
  return typeof company === 'string' && company.trim() ? company.trim() : null;
}

export interface Suggestion { accountId: string; why: string }
const same = (a: string | null | undefined, b: string | null | undefined) =>
  Boolean(a?.trim() && b?.trim() && a.trim().toLowerCase() === b.trim().toLowerCase());

/**
 * A retailer to pre-select for an undecided customer, with the evidence: the retailer's
 * billing email, the retailer's name as the customer's company, or another customer with
 * the same company already linked (one buyer under several customer records). Only an
 * unambiguous match is suggested.
 */
export function suggestRetailer(customer: Pick<CustomerRow, 'email' | 'company'>, retailers: RetailerOption[],
  linked: Array<Pick<CustomerRow, 'company' | 'account_id'>>): Suggestion | null {
  const unique = (ids: string[]) => [...new Set(ids)];
  const byEmail = unique(retailers.filter(r => same(r.billing_email, customer.email)).map(r => r.id));
  if (byEmail.length === 1) return { accountId: byEmail[0], why: 'the retailer’s billing email' };
  const byName = unique(retailers.filter(r => same(r.name, customer.company)).map(r => r.id));
  if (byName.length === 1) return { accountId: byName[0], why: 'the retailer’s name as its company' };
  const open = new Set(retailers.map(r => r.id));
  const bySibling = unique(linked.filter(l => l.account_id && open.has(l.account_id) && same(l.company, customer.company)).map(l => l.account_id!));
  if (bySibling.length === 1) return { accountId: bySibling[0], why: 'another customer with the same company' };
  return null;
}

/** Held shipments grouped by Shopify customer id, oldest first; shipments without one last. */
export function groupHeld(shipments: HeldShipment[]): Array<{ shopifyCustomerId: string | null; shipments: HeldShipment[] }> {
  const groups = new Map<string | null, HeldShipment[]>();
  for (const s of [...shipments].sort((a, b) => a.occurred_at.localeCompare(b.occurred_at) || a.id.localeCompare(b.id))) {
    const key = s.order?.shopify_customer_id ?? null;
    groups.set(key, [...(groups.get(key) ?? []), s]);
  }
  return [...groups.entries()].map(([shopifyCustomerId, list]) => ({ shopifyCustomerId, shipments: list }))
    .sort((a, b) => (a.shopifyCustomerId === null ? 1 : 0) - (b.shopifyCustomerId === null ? 1 : 0));
}

export const CUSTOMER_OUTCOMES = {
  linked: { ok: true, text: 'Customer linked. Its unpaid orders shipped from the warehouse are invoiced to that retailer.' },
  not_invoiced: { ok: true, text: 'Customer marked not invoiced. Atlas will not invoice its orders.' },
  undecided: { ok: true, text: 'Decision removed. Its unpaid draft orders will wait here again when they ship.' },
  unchanged: { ok: true, text: 'That was already the decision. Nothing changed.' },
  reason_required: { ok: false, text: 'Give a reason of at least three characters to stop invoicing a customer. Nothing changed.' },
  retailer_required: { ok: false, text: 'Choose the retailer to link. Nothing changed.' },
  retailer_closed: { ok: false, text: 'That retailer is closed, so nothing can be invoiced to it. Nothing changed.' },
  stale: { ok: false, text: 'Someone changed this customer’s decision since the page was loaded. Nothing changed; check the current decision below.' },
  not_found: { ok: false, text: 'That customer or retailer no longer exists for this business. Nothing changed.' },
  not_allowed: { ok: false, text: 'Deciding customers is switched off for this business (its operator grant is missing or revoked). Nothing changed.' },
  paused: { ok: false, text: 'Business actions are paused, so nothing changed. Resume them first.' },
  failed: { ok: false, text: 'The change could not be saved. Nothing changed; try again.' },
} as const;
export type CustomerOutcome = keyof typeof CUSTOMER_OUTCOMES;

const ERRORS: Array<[RegExp, CustomerOutcome]> = [
  [/business actions paused/, 'paused'],
  [/tool entitlement missing or revoked|must not require approval|agent disabled/, 'not_allowed'],
  [/a reason is required|reason too long/, 'reason_required'],
  [/retailer is closed/, 'retailer_closed'],
  [/changed since it was loaded/, 'stale'],
  [/customer not found|retailer not found/, 'not_found'],
];
export function customerOutcomeFor(errorMessage: string): CustomerOutcome {
  return ERRORS.find(([pattern]) => pattern.test(errorMessage))?.[1] ?? 'failed';
}
export function isCustomerOutcome(value: unknown): value is CustomerOutcome {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CUSTOMER_OUTCOMES, value);
}

/** What a successful decision says, with what it released. */
export function decidedText(decision: Decision, released: number, notInvoiced: number): string {
  const parts: string[] = [];
  if (released > 0) parts.push(`${released} waiting ${released === 1 ? 'shipment goes' : 'shipments go'} to invoicing`);
  if (notInvoiced > 0) parts.push(`${notInvoiced} waiting ${notInvoiced === 1 ? 'shipment is' : 'shipments are'} not invoiced`);
  const base = CUSTOMER_OUTCOMES[decision === 'retailer' ? 'linked' : decision].text;
  return parts.length ? `${base} ${parts.join('; ')}.` : base;
}
