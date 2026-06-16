// Builds a `PolicyState` from canonical Atlas tables. One builder per action — each
// action knows which tables to read and how to shape its action history + preconditions.
//
// Phase 1's first consumer is `controller.issue_invoice`. Its state comes from:
//   - recentActions   ← invoices with state in ('issued','paid','partial') (the
//                       money-moving "actions" of an issue_invoice)
//   - completedSubjectKeys ← invoices.fulfillment_event_id (one invoice per fulfillment)
//   - preconditions   ← fulfillment_events where route='wholesale' (verified-before-acting)
//
// As more actions get policy gates, this module grows new builders. The action name is
// the dispatch key.

import { supabase, orgId } from '../../data/supabase.js';
import type { ActionRecord, PolicyState, Precondition } from './types.js';

export type StateBuilder = () => Promise<PolicyState>;

const BUILDERS: Record<string, StateBuilder> = {};

export function registerStateBuilder(action: string, builder: StateBuilder): void {
  BUILDERS[action] = builder;
}

/**
 * Resolve the state builder for an action. Falls back to an empty state if no builder is
 * registered for the action — rules that depend on state (rollingWindow, conditionalGate,
 * idempotency) will then default-pass on missing data.
 */
export async function buildState(action: string): Promise<PolicyState> {
  const builder = BUILDERS[action];
  if (builder) return await builder();
  return {
    recentActions: [],
    completedSubjectKeys: new Set(),
    preconditions: [],
    now: Date.now(),
  };
}

// ---------- controller.issue_invoice ----------

registerStateBuilder('controller.issue_invoice', async () => {
  const sb = supabase();
  const now = Date.now();

  // recentActions ← invoices already issued / paid / partial (these spent money out of
  // the AR allowance for rolling-window purposes).
  const { data: issued, error: issuedErr } = await sb
    .from('invoices')
    .select('id, total_cents, currency, account_id, fulfillment_event_id, issued_at, state, stripe_invoice_id')
    .eq('org_id', orgId())
    .in('state', ['issued', 'paid', 'partial'])
    .order('issued_at', { ascending: false })
    .limit(500);
  if (issuedErr) throw issuedErr;

  const recentActions: ActionRecord[] = (issued ?? []).map((inv) => ({
    action: 'controller.issue_invoice',
    subjectType: 'invoice',
    subjectId: inv.id as string,
    amount: BigInt(inv.total_cents as number),
    currency: inv.currency as string,
    attributes: {
      account_id: (inv.account_id as string | null) ?? null,
      fulfillment_event_id: (inv.fulfillment_event_id as string | null) ?? null,
    },
    occurredAt: inv.issued_at ? Date.parse(inv.issued_at as string) : 0,
    txRef: (inv.stripe_invoice_id as string | null) ?? null,
    decision: 'allow',
  }));

  // completedSubjectKeys ← every invoiced fulfillment_event_id (regardless of invoice
  // state — once we've drafted an invoice for a fulfillment, we don't draft another).
  const { data: invoicedFulfillments, error: invFulErr } = await sb
    .from('invoices')
    .select('fulfillment_event_id')
    .eq('org_id', orgId())
    .not('fulfillment_event_id', 'is', null);
  if (invFulErr) throw invFulErr;
  const completedSubjectKeys = new Set<string>(
    (invoicedFulfillments ?? [])
      .map((r) => r.fulfillment_event_id as string | null)
      .filter((s): s is string => s !== null),
  );

  // preconditions ← wholesale fulfillment_events that are ready to invoice. The
  // controller's `controller.fulfillment.routed` projection already classifies these
  // (route='wholesale' with non-null account_id).
  const { data: fulfillments, error: fulErr } = await sb
    .from('fulfillment_events')
    .select('id, account_id, shopify_order_id, occurred_at, route')
    .eq('org_id', orgId())
    .eq('route', 'wholesale');
  if (fulErr) throw fulErr;

  // For Phase 1 we don't pre-compute the amount here — the invoice draft builder will
  // resolve pricing from the price book at draft time, and the conditionalGate rule will
  // compare the draft total against the precondition. We carry an `amount: 0n` placeholder
  // and rely on the draft builder writing the matching amount onto the input.
  const preconditions: Precondition[] = (fulfillments ?? []).map((f) => ({
    kind: 'wholesale_fulfillment',
    key: f.id as string,
    amount: 0n,
    currency: 'NZD',
    attributes: {
      account_id: (f.account_id as string | null) ?? null,
      shopify_order_id: f.shopify_order_id as string,
    },
    verifiedAt: f.occurred_at ? Date.parse(f.occurred_at as string) : 0,
  }));

  return {
    recentActions,
    completedSubjectKeys,
    preconditions,
    now,
  };
});
