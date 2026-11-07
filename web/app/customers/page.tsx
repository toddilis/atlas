// Shopify customers (CONFIG-01d, 0054): who Atlas invoices. A shipment from the warehouse
// is invoiced when its order's Shopify customer is linked to a retailer and Shopify shows
// the order unpaid; an order Shopify shows as paid never is. An unpaid draft order from a
// customer nobody has decided about waits here until someone links the customer to a
// retailer or marks it not invoiced, and that decision releases its waiting shipments.
// Suggestions only pre-select a retailer; the operator confirms every decision.

import Link from 'next/link';
import { supabaseServer, orgId } from '@/lib/supabase';
import { formatCents, formatDate, formatDateTime } from '@/lib/format';
import {
  companyOf, CUSTOMER_OUTCOMES, customerName, decidedText, decisionToken, groupHeld, isCustomerOutcome, suggestRetailer,
  type CustomerRow, type HeldShipment, type RetailerOption, type Suggestion,
} from '@/lib/customers';

export const dynamic = 'force-dynamic';

const COLUMNS = 'id, shopify_customer_id, email, first_name, last_name, default_address, tags, account_id, do_not_invoice, decision_note, decided_at, decided_by';
type StoredCustomer = Omit<CustomerRow, 'company'> & { default_address: unknown };
const toRow = (c: StoredCustomer): CustomerRow => {
  const { default_address, ...rest } = c;
  return { ...rest, company: companyOf(default_address) };
};

async function loadCustomers(q: string) {
  const sb = await supabaseServer();
  const org = orgId();
  const [held, linked, notInvoiced, accounts, grants, controls, found] = await Promise.all([
    sb.from('fulfillment_events')
      .select('id, occurred_at, order:shopify_orders(shopify_order_name, shopify_customer_id, financial_status, total_cents, currency)')
      .eq('org_id', org).eq('route', 'held').order('occurred_at').limit(500),
    sb.from('shopify_customers').select(COLUMNS).eq('org_id', org).not('account_id', 'is', null).limit(1000),
    sb.from('shopify_customers').select(COLUMNS).eq('org_id', org).eq('do_not_invoice', true).limit(1000),
    sb.from('accounts').select('id, name, billing_email, status').eq('org_id', org).order('name').limit(1000),
    sb.from('tool_grants').select('enabled').eq('org_id', org).eq('agent_name', 'operator').eq('tool_name', 'customers.decide'),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
    q.length >= 2 ? sb.rpc('search_shopify_customers', { p_org_id: org, p_query: q, p_limit: 50 }) : Promise.resolve({ data: [], error: null }),
  ]);
  for (const r of [held, linked, notInvoiced, accounts, grants, controls, found]) if (r.error) throw r.error;
  const shipments = (held.data ?? []) as unknown as HeldShipment[];
  const heldIds = [...new Set(shipments.map(s => s.order?.shopify_customer_id).filter((id): id is string => Boolean(id)))];
  const heldCustomers = heldIds.length > 0
    ? await sb.from('shopify_customers').select(COLUMNS).eq('org_id', org).in('shopify_customer_id', heldIds)
    : { data: [], error: null };
  if (heldCustomers.error) throw heldCustomers.error;
  const paused = Boolean(controls.data?.paused);
  const allAccounts = (accounts.data ?? []) as Array<RetailerOption & { status: string }>;
  const byName = (a: CustomerRow, b: CustomerRow) => customerName(a).localeCompare(customerName(b));
  return {
    shipments,
    heldCustomers: new Map(((heldCustomers.data ?? []) as unknown as StoredCustomer[]).map(c => [c.shopify_customer_id, toRow(c)])),
    linked: ((linked.data ?? []) as unknown as StoredCustomer[]).map(toRow).sort(byName),
    notInvoiced: ((notInvoiced.data ?? []) as unknown as StoredCustomer[]).map(toRow).sort(byName),
    found: (found.data ?? []) as unknown as CustomerRow[],
    retailers: allAccounts.filter(a => a.status !== 'closed'),
    retailerNames: new Map(allAccounts.map(a => [a.id, a.name])),
    can: !paused && (grants.data ?? []).some(g => g.enabled),
    note: paused ? 'Business actions are paused, so customer decisions cannot change until they are resumed.'
      : (grants.data ?? []).some(g => g.enabled) ? null
        : 'Deciding customers is switched off for this business (the operator customers.decide grant is missing or revoked).',
  };
}

const field = 'rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-2 py-1 text-sm';
const button = 'rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-3 py-1 text-sm font-medium';
const quiet = 'rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1 text-sm';

function Who({ c }: { c: CustomerRow }) {
  return (
    <div className="space-y-0.5">
      <div className="font-medium">{customerName(c)}{c.company ? <span className="font-normal text-zinc-600 dark:text-zinc-400"> · {c.company}</span> : null}</div>
      <div className="text-xs text-zinc-500">{[c.email, `Shopify ${c.shopify_customer_id}`].filter(Boolean).join(' · ')}</div>
    </div>
  );
}

function Decide({ c, retailers, suggestion, q }: { c: CustomerRow; retailers: RetailerOption[]; suggestion: Suggestion | null; q: string }) {
  const name = customerName(c);
  const token = decisionToken(c);
  const hidden = (decision: string) => (
    <>
      <input type="hidden" name="customer_id" value={c.id} />
      <input type="hidden" name="decision" value={decision} />
      <input type="hidden" name="expected" value={token} />
      {q ? <input type="hidden" name="q" value={q} /> : null}
    </>
  );
  return (
    <div className="flex flex-wrap items-end gap-4">
      <form method="post" action="/customers/decide" className="flex flex-wrap items-end gap-2">
        {hidden('retailer')}
        <label className="text-xs text-zinc-500">Retailer<br />
          <select name="account_id" aria-label={`Retailer for ${name}`} required defaultValue={c.account_id ?? suggestion?.accountId ?? ''} className={`${field} w-56`}>
            <option value="" disabled>Choose a retailer</option>
            {retailers.map(r => <option key={r.id} value={r.id}>{r.name}</option>)}
          </select></label>
        <button type="submit" className={button}>{c.account_id ? 'Change retailer' : 'Link'}</button>
        {suggestion && !c.account_id ? <span className="pb-1 text-xs text-zinc-500" data-testid="customer-suggestion">Suggested: matches {suggestion.why}</span> : null}
      </form>
      {c.do_not_invoice ? null : (
        <form method="post" action="/customers/decide" className="flex flex-wrap items-end gap-2">
          {hidden('not_invoiced')}
          <label className="text-xs text-zinc-500">Reason<br />
            <input name="note" aria-label={`Reason not invoiced for ${name}`} required minLength={3} maxLength={500}
              placeholder="Rep kit" className={`${field} w-48`} /></label>
          <button type="submit" className={quiet}>Don&rsquo;t invoice</button>
        </form>
      )}
      {token === 'undecided' ? null : (
        <form method="post" action="/customers/decide">
          {hidden('undecided')}
          <button type="submit" className={quiet}>Remove decision</button>
        </form>
      )}
    </div>
  );
}

export default async function CustomersPage({ searchParams }: { searchParams: Promise<{ outcome?: string; q?: string; released?: string; kept?: string }> }) {
  const params = await searchParams;
  const q = (params.q ?? '').trim().slice(0, 100);
  const count = (v: string | undefined) => { const n = Number.parseInt(v ?? '', 10); return Number.isSafeInteger(n) && n > 0 && n < 100000 ? n : 0; };
  const outcome = isCustomerOutcome(params.outcome) ? params.outcome : null;
  const notice = !outcome ? null
    : outcome === 'linked' || outcome === 'not_invoiced' || outcome === 'undecided'
      ? { ok: true, text: decidedText(outcome === 'linked' ? 'retailer' : outcome, count(params.released), count(params.kept)) }
      : CUSTOMER_OUTCOMES[outcome];
  const data = await loadCustomers(q);
  const groups = groupHeld(data.shipments);
  const suggest = (c: CustomerRow) => (c.account_id || c.do_not_invoice ? null : suggestRetailer(c, data.retailers, data.linked));
  const retailerName = (id: string | null) => (id ? data.retailerNames.get(id) ?? 'Retailer' : '—');

  return (
    <div className="space-y-8">
      <div className="space-y-2">
        <h1 className="text-2xl font-semibold">Shopify customers</h1>
        <p className="text-sm text-zinc-600 dark:text-zinc-400 max-w-3xl">
          Atlas invoices a shipment from the warehouse when its order&rsquo;s Shopify customer is linked to a retailer and Shopify
          shows the order unpaid. An order Shopify shows as paid is never invoiced. When an unpaid draft order ships for a customer
          nobody has decided about yet, it waits here: link the customer to its retailer to invoice it, or mark the customer not
          invoiced (a rep&rsquo;s kit, say). Retailers are set up on the <Link href="/catalog" className="underline">Catalogue</Link>.
        </p>
      </div>

      {notice ? (
        <div data-testid="customer-notice" role="status" className={`rounded-lg border p-4 text-sm ${notice.ok
          ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
          : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'}`}>
          {notice.text}
        </div>
      ) : null}
      {data.note ? <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-3 text-sm text-zinc-600 dark:text-zinc-400" data-testid="customers-note">{data.note}</div> : null}

      <section className="space-y-3" aria-label="Waiting for a decision" data-testid="customers-waiting">
        <h2 className="text-lg font-semibold">Waiting for a decision</h2>
        {groups.length === 0 ? (
          <div className="text-sm text-zinc-500" data-testid="customers-waiting-empty">No shipments are waiting. Unpaid draft orders from customers nobody has decided about appear here when they ship.</div>
        ) : groups.map(g => {
          const c = g.shopifyCustomerId ? data.heldCustomers.get(g.shopifyCustomerId) ?? null : null;
          return (
            <div key={g.shopifyCustomerId ?? 'none'} id={c ? `customer-${c.id}` : undefined} data-testid="waiting-customer"
              className="rounded-lg border border-amber-300 dark:border-amber-800 p-4 space-y-3">
              {c ? <Who c={c} /> : (
                <div className="text-sm">{g.shopifyCustomerId
                  ? `Shopify customer ${g.shopifyCustomerId} has not synced yet; it appears here after the next Shopify sync.`
                  : 'These shipments have no Shopify customer; invoice them by hand.'}</div>
              )}
              <ul className="text-sm text-zinc-600 dark:text-zinc-400" aria-label="Waiting shipments">
                {g.shipments.map(s => (
                  <li key={s.id}>
                    Order {s.order?.shopify_order_name ?? '—'} shipped {formatDateTime(s.occurred_at)}
                    {s.order?.total_cents != null && s.order.currency ? ` · order total ${formatCents(s.order.total_cents, s.order.currency)}` : ''}
                    {' · '}{s.order?.financial_status === 'pending' ? 'unpaid in Shopify' : `${s.order?.financial_status ?? 'payment status unknown'} in Shopify`}
                  </li>
                ))}
              </ul>
              {c && data.can ? <Decide c={c} retailers={data.retailers} suggestion={suggest(c)} q={q} /> : null}
            </div>
          );
        })}
      </section>

      <section className="space-y-3" aria-label="Find a customer">
        <h2 className="text-lg font-semibold">Find a customer</h2>
        <form method="get" action="/customers" className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-zinc-500">Name, email, company or Shopify id<br />
            <input name="q" aria-label="Search customers" defaultValue={q} minLength={2} maxLength={100} className={`${field} w-72`} /></label>
          <button type="submit" className={quiet}>Search</button>
        </form>
        {q.length >= 2 ? (
          data.found.length === 0 ? <div className="text-sm text-zinc-500" data-testid="customers-found-empty">No customer matches &ldquo;{q}&rdquo;.</div> : (
            <ul className="divide-y divide-zinc-100 dark:divide-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800">
              {data.found.map(c => (
                <li key={c.id} id={`customer-${c.id}`} data-testid="found-customer" className="p-3 space-y-2 text-sm">
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <Who c={c} />
                    <span className="text-xs text-zinc-500">{c.account_id ? `Linked to ${retailerName(c.account_id)}`
                      : c.do_not_invoice ? `Not invoiced: ${c.decision_note}` : 'Not decided'}</span>
                  </div>
                  {data.can ? <Decide c={c} retailers={data.retailers} suggestion={suggest(c)} q={q} /> : null}
                </li>
              ))}
            </ul>
          )
        ) : null}
        {q.length >= 2 && data.found.length === 50 ? <div className="text-xs text-zinc-500">Showing the first 50 matches; search more precisely to see others.</div> : null}
      </section>

      <section className="space-y-3" aria-label="Linked to retailers">
        <h2 className="text-lg font-semibold">Linked to retailers</h2>
        {data.linked.length === 0 ? <div className="text-sm text-zinc-500" data-testid="customers-linked-empty">No customer is linked to a retailer yet.</div> : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800">
            {data.linked.map(c => (
              <li key={c.id} id={`customer-${c.id}`} data-testid="linked-customer" className="p-3 space-y-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Who c={c} />
                  <span className="text-right">
                    <span className="font-medium">{retailerName(c.account_id)}</span>
                    <span className="block text-xs text-zinc-500">{c.decided_by ? `Linked by ${c.decided_by}, ${formatDate(c.decided_at)}` : 'Linked before decisions were recorded'}</span>
                  </span>
                </div>
                {data.can ? (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-zinc-500">Change decision</summary>
                    <div className="mt-2"><Decide c={c} retailers={data.retailers} suggestion={null} q={q} /></div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="space-y-3" aria-label="Not invoiced">
        <h2 className="text-lg font-semibold">Not invoiced</h2>
        {data.notInvoiced.length === 0 ? <div className="text-sm text-zinc-500" data-testid="customers-not-invoiced-empty">No customer is marked not invoiced.</div> : (
          <ul className="divide-y divide-zinc-100 dark:divide-zinc-900 rounded-lg border border-zinc-200 dark:border-zinc-800">
            {data.notInvoiced.map(c => (
              <li key={c.id} id={`customer-${c.id}`} data-testid="not-invoiced-customer" className="p-3 space-y-2 text-sm">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <Who c={c} />
                  <span className="text-right">
                    <span className="font-medium">{c.decision_note}</span>
                    <span className="block text-xs text-zinc-500">{c.decided_by ? `Marked by ${c.decided_by}, ${formatDate(c.decided_at)}` : ''}</span>
                  </span>
                </div>
                {data.can ? (
                  <details className="text-sm">
                    <summary className="cursor-pointer text-zinc-500">Change decision</summary>
                    <div className="mt-2"><Decide c={c} retailers={data.retailers} suggestion={null} q={q} /></div>
                  </details>
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}
