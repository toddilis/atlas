'use client';

// Pricing editor (PRICING-01). Edits a draft of the next version in the browser, checks it
// against the same schema the server uses, and previews a hypothetical order with the same
// calculator invoices use. Saving and activating post to the protected routes; the server
// and database decide (lib/pricing-action.ts, 0033). A refusal keeps the draft as it is.

import { useMemo, useState } from 'react';
import { PricingConfigSchema, previewPricing, type PricingConfig, type PricingSnapshot } from '../../src/platform/pricing/versioned';
import {
  PRICING_OUTCOMES, fromBps, fromMinor, issueLabel, previewInput, toBps, toMinor,
  type AccountOption, type PreviewRequest, type PricingOutcome, type ProductOption,
} from '../lib/pricing';

export interface PricingEditorProps {
  initialConfig: PricingConfig;
  activeConfig: PricingConfig | null;
  latest: { id: string; revision: number; versionKey: string; activated: boolean; config: PricingConfig } | null;
  expectedRevision: number;
  products: ProductOption[];
  accounts: AccountOption[];
  canSave: boolean;
  canActivate: boolean;
}
type Issue = { label: string; message: string };
type Preview = { status: 'ready'; snapshot: PricingSnapshot } | { status: 'blocked'; reason: string };

const field = 'border rounded px-2 py-1.5 w-full bg-white text-zinc-900 dark:bg-zinc-900 dark:text-zinc-100 border-zinc-300 dark:border-zinc-700';
const button = 'border rounded px-3 py-1.5 text-sm disabled:opacity-40 border-zinc-300 dark:border-zinc-700';
const small = 'text-xs text-zinc-500';

function Field({ label, children, hint }: { label: string; children: React.ReactNode; hint?: React.ReactNode }) {
  return <label className="block text-sm space-y-1"><span>{label}</span>{children}{hint && <span className={`block ${small}`}>{hint}</span>}</label>;
}
/** Dollars as typed; the config holds exact minor units. An unreadable amount is kept as
 * "invalid" so the schema refuses the draft instead of guessing. */
function MoneyInput({ label, value, onChange }: { label: string; value: string; onChange: (minor: string) => void }) {
  const [text, setText] = useState(fromMinor(value));
  const bad = text.trim() !== '' && toMinor(text) === null;
  return <span className="block"><input aria-label={label} className={field} inputMode="decimal" value={text} placeholder="0.00"
    onChange={e => { setText(e.target.value); onChange(toMinor(e.target.value) ?? (e.target.value.trim() ? 'invalid' : '')); }} />
    {bad && <span className="text-xs text-red-700">Use an amount like 12.50</span>}</span>;
}
function PercentInput({ label, value, onChange }: { label: string; value: number | null; onChange: (bps: number | null) => void }) {
  const [text, setText] = useState(fromBps(value));
  const bad = text.trim() !== '' && toBps(text) === null;
  return <span className="block"><input aria-label={label} className={field} inputMode="decimal" value={text} placeholder="0"
    onChange={e => { setText(e.target.value); onChange(toBps(e.target.value)); }} />
    {bad && <span className="text-xs text-red-700">Use a percentage from 0 to 100, at most two decimals</span>}</span>;
}
function Choice<T extends string>({ label, value, options, onChange }: { label: string; value: T | null; options: Array<[T, string]>; onChange: (v: T) => void }) {
  return <select aria-label={label} className={field} value={value ?? ''} onChange={e => onChange(e.target.value as T)}>
    <option value="" disabled>Choose…</option>{options.map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select>;
}
function YesNo({ label, value, onChange }: { label: string; value: boolean | null; onChange: (v: boolean) => void }) {
  return <Choice label={label} value={value === null ? null : value ? 'yes' : 'no'} options={[['yes', 'Yes'], ['no', 'No']]} onChange={v => onChange(v === 'yes')} />;
}
const nextId = (prefix: string, ids: string[]) => { let n = ids.length + 1; while (ids.includes(`${prefix}-${n}`)) n++; return `${prefix}-${n}`; };
function inZone(iso: string, zone: string) {
  const t = Date.parse(iso);
  if (!iso || Number.isNaN(t)) return 'Use an ISO time with its offset, for example 2026-11-01T00:00:00+13:00';
  try { return `${new Intl.DateTimeFormat('en-NZ', { dateStyle: 'medium', timeStyle: 'short', timeZone: zone || 'UTC' }).format(t)} in ${zone || 'UTC'}`; }
  catch { return 'Set a valid timezone to see this time locally'; }
}

export default function PricingEditor(props: PricingEditorProps) {
  const { products, accounts } = props;
  const [draft, setDraft] = useState<PricingConfig>(props.initialConfig);
  const update = (fn: (d: PricingConfig) => void) => setDraft(d => { const n = structuredClone(d); fn(n); return n; });
  const [reason, setReason] = useState('');
  const [activateReason, setActivateReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const [serverIssues, setServerIssues] = useState<Issue[]>([]);
  const nowIso = useMemo(() => new Date().toISOString(), []);
  const [request, setRequest] = useState<PreviewRequest>({
    accountId: accounts[0]?.id ?? '', taxExempt: accounts[0]?.taxExempt ?? false, orderAt: nowIso, dispatchAt: nowIso, destination: '',
    lines: [{ productId: products[0]!.id, description: products[0]!.name, ordered: 10, dispatched: 10 }], carrierCost: null, priorParts: 0,
  });
  const [preview, setPreview] = useState<{ draft: Preview; active: Preview | null } | null>(null);
  const [latestPreview, setLatestPreview] = useState<{ result: Preview; input: unknown } | null>(null);

  const check = PricingConfigSchema.safeParse(draft);
  const issues: Issue[] = check.success ? [] : check.error.issues.slice(0, 20).map(i => ({ label: issueLabel(i.path), message: i.message }));
  const productName = (id: string) => products.find(p => p.id === id)?.name ?? 'Unknown product';
  const accountName = (id: string | null) => id === null ? 'All retailers' : accounts.find(a => a.id === id)?.name ?? 'Unknown retailer';
  const money = (minor: string) => `${draft.currency ?? ''} ${fromMinor(minor)}`.trim();
  const accountOptions: Array<[string, string]> = [['*', 'All retailers'], ...accounts.map(a => [a.id, a.name] as [string, string])];
  const productOptions: Array<[string, string]> = products.map(p => [p.id, `${p.name} (${p.sku})`]);
  const allRuleIds = [...draft.negotiated, ...draft.tiers, ...draft.discounts].map(r => r.id);

  function calculate(config: PricingConfig): Preview { return previewPricing(config, previewInput(config, request, new Date())); }
  function runPreview() {
    setPreview({ draft: check.success ? calculate(draft) : { status: 'blocked', reason: 'Fix the draft first: the fields listed above are not valid yet.' },
      active: props.activeConfig ? calculate(props.activeConfig) : null });
  }
  function runLatestPreview() {
    if (!props.latest) return;
    const input = previewInput(props.latest.config, request, new Date());
    setLatestPreview({ result: previewPricing(props.latest.config, input), input });
  }
  async function post(path: string, body: unknown, success: PricingOutcome) {
    setBusy(true); setNotice(null); setServerIssues([]);
    try {
      const response = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      const result = await response.json().catch(() => ({ outcome: 'failed' }));
      if (result.outcome === success) { window.location.assign(`/pricing?outcome=${success}`); return; }
      if (result.outcome === 'signed_out') { window.location.assign('/login'); return; }
      const outcome = (result.outcome in PRICING_OUTCOMES ? result.outcome : 'failed') as PricingOutcome;
      setNotice({ ok: false, text: PRICING_OUTCOMES[outcome] });
      setServerIssues(Array.isArray(result.issues) ? result.issues : []);
    } catch { setNotice({ ok: false, text: PRICING_OUTCOMES.failed }); }
    finally { setBusy(false); }
  }
  const save = () => post('/pricing/save', { config: draft, expectedRevision: props.expectedRevision, reason }, 'saved');
  const activate = () => latestPreview?.result.status === 'ready' && props.latest && post('/pricing/activate', {
    versionId: props.latest.id, expectedRevision: props.latest.revision, reason: activateReason,
    previewInput: latestPreview.input, previewTotal: latestPreview.result.snapshot.total }, 'activated');

  const scopeValue = (id: string | null) => id ?? '*';
  const scopeOf = (v: string) => v === '*' ? null : v;

  return <section aria-labelledby="editor-heading" className="space-y-8">
    <div>
      <h2 id="editor-heading" className="text-lg font-medium">{props.latest ? `Next version (after revision ${props.latest.revision})` : 'First version'}</h2>
      <p className={small}>Edits stay in this page until you save them as a new version. {!props.canSave && 'Saving is switched off for this business (operator grant or pause), so you can only preview.'}</p>
    </div>
    {notice && <p role="status" aria-live="polite" className={`p-3 border rounded text-sm ${notice.ok ? '' : 'border-red-300 bg-red-50 text-red-900'}`}>{notice.text}</p>}

    <fieldset disabled={busy} className="grid md:grid-cols-3 gap-4">
      <legend className="font-medium mb-2">Version and timing</legend>
      <Field label="Version name"><input aria-label="Version name" className={field} value={draft.name} onChange={e => update(d => { d.name = e.target.value; })} /></Field>
      <Field label="Version identifier" hint="Must be new; shown on every invoice snapshot."><input aria-label="Version identifier" className={field} value={draft.version} onChange={e => update(d => { d.version = e.target.value; })} /></Field>
      <Field label="Timezone" hint="IANA name, for example Pacific/Auckland"><input aria-label="Timezone" className={field} value={draft.timezone} onChange={e => update(d => { d.timezone = e.target.value; })} /></Field>
      <Field label="Effective from (including this instant)" hint={inZone(draft.effectiveFrom, draft.timezone)}><input aria-label="Effective from" className={field} value={draft.effectiveFrom} onChange={e => update(d => { d.effectiveFrom = e.target.value; })} /></Field>
      <Field label="Effective until (excluding this instant, optional)" hint={draft.effectiveUntil ? inZone(draft.effectiveUntil, draft.timezone) : 'No end: a later version supersedes it.'}><input aria-label="Effective until" className={field} value={draft.effectiveUntil ?? ''} onChange={e => update(d => { d.effectiveUntil = e.target.value || null; })} /></Field>
      <Field label="Pricing date"><Choice label="Pricing date" value={draft.pricingDateBasis} options={[['order', 'Order date'], ['dispatch', 'Dispatch date']]} onChange={v => update(d => { d.pricingDateBasis = v; })} /></Field>
      <Field label="Currency"><Choice label="Currency" value={draft.currency} options={(['NZD', 'AUD', 'USD', 'EUR', 'GBP', 'CAD'] as const).map(c => [c, c])} onChange={v => update(d => { d.currency = v; })} /></Field>
      <Field label="Tax rate (%)" hint="Prices are tax exclusive; tax-exempt retailers are charged none."><PercentInput label="Tax rate" value={draft.taxRateBps} onChange={v => update(d => { d.taxRateBps = v as number; })} /></Field>
      <Field label="Freight taxable"><YesNo label="Freight taxable" value={draft.freightTaxable} onChange={v => update(d => { d.freightTaxable = v; })} /></Field>
      <Field label="Payment due day (of the following month)"><input aria-label="Payment due day" className={field} inputMode="numeric" value={draft.terms.day ?? ''} onChange={e => update(d => { d.terms.day = e.target.value === '' ? (null as unknown as number) : Number(e.target.value); })} /></Field>
      <Field label="Due month follows"><Choice label="Due month follows" value={draft.terms.anchor} options={[['invoice', 'The invoice date'], ['dispatch', 'The dispatch date']]} onChange={v => update(d => { d.terms.anchor = v; })} /></Field>
    </fieldset>

    <fieldset disabled={busy} className="space-y-4">
      <legend className="font-medium mb-2">How a price is chosen</legend>
      <div className="grid md:grid-cols-3 gap-4">
        {[0, 1, 2].map(i => <Field key={i} label={`${['First', 'Then', 'Last'][i]} try`}><Choice label={`Price precedence ${i + 1}`} value={draft.pricePrecedence[i] ?? null}
          options={[['negotiated', 'Negotiated price'], ['tier', 'Volume tier'], ['book', 'Price book']]} onChange={v => update(d => { d.pricePrecedence[i] = v; })} /></Field>)}
        <Field label="Volume tier quantity"><Choice label="Volume tier quantity" value={draft.tierQuantityBasis} options={[['ordered', 'Whole ordered quantity'], ['dispatched', 'Quantity in this dispatch']]} onChange={v => update(d => { d.tierQuantityBasis = v; })} /></Field>
        <Field label="Retailers without a price book"><Choice label="Retailers without a price book" value={draft.fallback} options={[['default_book', 'Use the default book'], ['none', 'Refuse to price']]} onChange={v => update(d => { d.fallback = v; })} /></Field>
        <Field label="Discount combination"><Choice label="Discount combination" value={draft.discountCombination} options={[['single', 'One discount per product'], ['sequential', 'Apply in configured order']]} onChange={v => update(d => { d.discountCombination = v; })} /></Field>
        <Field label="Discounts also apply to negotiated and tier prices"><YesNo label="Discounts on special prices" value={draft.discountOnSpecialPrice} onChange={v => update(d => { d.discountOnSpecialPrice = v; })} /></Field>
      </div>
    </fieldset>

    <fieldset disabled={busy} className="space-y-4">
      <legend className="font-medium mb-2">Price books</legend>
      {draft.books.map((book, b) => <div key={b} className="border rounded p-3 space-y-2 border-zinc-200 dark:border-zinc-800">
        <div className="grid md:grid-cols-3 gap-3 items-end">
          <Field label="Book name"><input aria-label={`Book ${b + 1} name`} className={field} value={book.id} onChange={e => update(d => { const old = d.books[b]!.id; d.books[b]!.id = e.target.value; d.bindings.forEach(x => { if (x.bookId === old) x.bookId = e.target.value; }); })} /></Field>
          <label className="text-sm"><input type="radio" name="default-book" checked={book.isDefault} onChange={() => update(d => { d.books.forEach((x, i) => { x.isDefault = i === b; }); })} /> Default book</label>
          <button type="button" className={button} disabled={draft.books.length === 1} onClick={() => update(d => { d.books.splice(b, 1); })}>Remove book</button>
        </div>
        <table className="w-full text-sm"><thead className="text-zinc-500 text-left"><tr><th className="py-1">Product</th><th>Unit price</th><th /></tr></thead><tbody>
          {book.entries.map((entry, e) => <tr key={`${b}-${e}-${entry.productId}`}>
            <td className="pr-3 py-1"><Choice label={`Book ${b + 1} product ${e + 1}`} value={entry.productId} options={productOptions} onChange={v => update(d => { d.books[b]!.entries[e]!.productId = v; })} /></td>
            <td className="pr-3"><MoneyInput label={`Price of ${productName(entry.productId)} in ${book.id}`} value={entry.unitPrice} onChange={v => update(d => { d.books[b]!.entries[e]!.unitPrice = v; })} /></td>
            <td><button type="button" className={button} onClick={() => update(d => { d.books[b]!.entries.splice(e, 1); })}>Remove</button></td>
          </tr>)}
        </tbody></table>
        <button type="button" className={button} onClick={() => update(d => { const used = d.books[b]!.entries.map(x => x.productId); const p = products.find(x => !used.includes(x.id)); if (p) d.books[b]!.entries.push({ productId: p.id, unitPrice: '' }); })}>Add product</button>
      </div>)}
      <button type="button" className={button} onClick={() => update(d => { d.books.push({ id: nextId('book', d.books.map(x => x.id)), isDefault: false, entries: [{ productId: products[0]!.id, unitPrice: '' }] }); })}>Add price book</button>
    </fieldset>

    <fieldset disabled={busy} className="space-y-3">
      <legend className="font-medium mb-2">Retailer price books</legend>
      {draft.bindings.length === 0 && <p className={small}>No retailer has its own book{draft.fallback === 'default_book' ? '; all use the default book.' : '.'}</p>}
      {draft.bindings.map((x, i) => <div key={i} className="grid md:grid-cols-3 gap-3 items-end">
        <Field label="Retailer"><Choice label={`Binding ${i + 1} retailer`} value={x.accountId} options={accounts.map(a => [a.id, a.name])} onChange={v => update(d => { d.bindings[i]!.accountId = v; })} /></Field>
        <Field label="Price book"><Choice label={`Binding ${i + 1} book`} value={x.bookId} options={draft.books.map(bk => [bk.id, bk.id])} onChange={v => update(d => { d.bindings[i]!.bookId = v; })} /></Field>
        <button type="button" className={button} onClick={() => update(d => { d.bindings.splice(i, 1); })}>Remove</button>
      </div>)}
      <button type="button" className={button} disabled={accounts.length === 0} onClick={() => update(d => { d.bindings.push({ accountId: accounts.find(a => !d.bindings.some(x => x.accountId === a.id))?.id ?? accounts[0]!.id, bookId: d.books[0]!.id }); })}>Give a retailer its own book</button>
    </fieldset>

    <fieldset disabled={busy} className="space-y-3">
      <legend className="font-medium mb-2">Negotiated prices and volume tiers</legend>
      {draft.negotiated.map((r, i) => <div key={r.id} className="grid md:grid-cols-4 gap-3 items-end">
        <Field label="Retailer"><Choice label={`Negotiated ${i + 1} retailer`} value={scopeValue(r.accountId)} options={accountOptions} onChange={v => update(d => { d.negotiated[i]!.accountId = scopeOf(v); })} /></Field>
        <Field label="Product"><Choice label={`Negotiated ${i + 1} product`} value={r.productId} options={productOptions} onChange={v => update(d => { d.negotiated[i]!.productId = v; })} /></Field>
        <Field label="Unit price"><MoneyInput label={`Negotiated ${i + 1} price`} value={r.unitPrice} onChange={v => update(d => { d.negotiated[i]!.unitPrice = v; })} /></Field>
        <button type="button" className={button} onClick={() => update(d => { d.negotiated.splice(i, 1); })}>Remove</button>
      </div>)}
      <button type="button" className={button} onClick={() => update(d => { d.negotiated.push({ id: nextId('negotiated', allRuleIds), accountId: accounts[0]?.id ?? null, productId: products[0]!.id, unitPrice: '' }); })}>Add negotiated price</button>
      {draft.tiers.map((r, i) => <div key={r.id} className="grid md:grid-cols-5 gap-3 items-end">
        <Field label="Retailer"><Choice label={`Tier ${i + 1} retailer`} value={scopeValue(r.accountId)} options={accountOptions} onChange={v => update(d => { d.tiers[i]!.accountId = scopeOf(v); })} /></Field>
        <Field label="Product"><Choice label={`Tier ${i + 1} product`} value={r.productId} options={productOptions} onChange={v => update(d => { d.tiers[i]!.productId = v; })} /></Field>
        <Field label="From quantity"><input aria-label={`Tier ${i + 1} minimum`} className={field} inputMode="numeric" value={r.minimum || ''} onChange={e => update(d => { d.tiers[i]!.minimum = Number(e.target.value); })} /></Field>
        <Field label="Unit price"><MoneyInput label={`Tier ${i + 1} price`} value={r.unitPrice} onChange={v => update(d => { d.tiers[i]!.unitPrice = v; })} /></Field>
        <button type="button" className={button} onClick={() => update(d => { d.tiers.splice(i, 1); })}>Remove</button>
      </div>)}
      <button type="button" className={button} onClick={() => update(d => { d.tiers.push({ id: nextId('tier', allRuleIds), accountId: null, productId: products[0]!.id, minimum: 0, unitPrice: '' }); })}>Add volume tier</button>
    </fieldset>

    <fieldset disabled={busy} className="space-y-3">
      <legend className="font-medium mb-2">Discounts</legend>
      {draft.discounts.map((r, i) => <div key={r.id} className="grid md:grid-cols-6 gap-3 items-end">
        <Field label="Retailer"><Choice label={`Discount ${i + 1} retailer`} value={scopeValue(r.accountId)} options={accountOptions} onChange={v => update(d => { d.discounts[i]!.accountId = scopeOf(v); })} /></Field>
        <Field label="Product"><Choice label={`Discount ${i + 1} product`} value={r.productId} options={productOptions} onChange={v => update(d => { d.discounts[i]!.productId = v; })} /></Field>
        <Field label="Kind"><Choice label={`Discount ${i + 1} kind`} value={r.discount.kind} options={[['percent', 'Percentage'], ['fixed', 'Amount per unit']]} onChange={v => update(d => { d.discounts[i]!.discount = v === 'percent' ? { kind: 'percent', bps: null as unknown as number } : { kind: 'fixed', amount: '' }; })} /></Field>
        <Field label={r.discount.kind === 'percent' ? 'Percentage' : 'Amount per unit'}>{r.discount.kind === 'percent'
          ? <PercentInput key={`${r.id}-p`} label={`Discount ${i + 1} percentage`} value={r.discount.bps} onChange={v => update(d => { d.discounts[i]!.discount = { kind: 'percent', bps: v as number }; })} />
          : <MoneyInput key={`${r.id}-f`} label={`Discount ${i + 1} amount`} value={r.discount.amount} onChange={v => update(d => { d.discounts[i]!.discount = { kind: 'fixed', amount: v }; })} />}</Field>
        <Field label="Order"><input aria-label={`Discount ${i + 1} order`} className={field} inputMode="numeric" value={r.order} onChange={e => update(d => { d.discounts[i]!.order = Number(e.target.value); })} /></Field>
        <button type="button" className={button} onClick={() => update(d => { d.discounts.splice(i, 1); })}>Remove</button>
      </div>)}
      <button type="button" className={button} onClick={() => update(d => { d.discounts.push({ id: nextId('discount', allRuleIds), accountId: null, productId: products[0]!.id, order: d.discounts.length, discount: { kind: 'percent', bps: null as unknown as number } }); })}>Add discount</button>
    </fieldset>

    <fieldset disabled={busy} className="space-y-3">
      <legend className="font-medium mb-2">Shipping</legend>
      <label className="text-sm"><input type="checkbox" checked={draft.shipping.enabled} onChange={e => update(d => { d.shipping.enabled = e.target.checked; if (!e.target.checked) d.shipping.rules = []; })} /> This business charges freight</label>
      {draft.shipping.rules.map((r, i) => <div key={r.id} className="border rounded p-3 grid md:grid-cols-4 gap-3 border-zinc-200 dark:border-zinc-800">
        <Field label="Retailer"><Choice label={`Shipping rule ${i + 1} retailer`} value={scopeValue(r.accountId)} options={accountOptions} onChange={v => update(d => { d.shipping.rules[i]!.accountId = scopeOf(v); })} /></Field>
        <Field label="Destination (optional)" hint="Only applies when the dispatch's destination is known."><input aria-label={`Shipping rule ${i + 1} destination`} className={field} value={r.destination ?? ''} onChange={e => update(d => { d.shipping.rules[i]!.destination = e.target.value.trim() || null; })} /></Field>
        <Field label="Priority" hint="Higher wins; two rules that tie conflict."><input aria-label={`Shipping rule ${i + 1} priority`} className={field} inputMode="numeric" value={r.priority} onChange={e => update(d => { d.shipping.rules[i]!.priority = Number(e.target.value); })} /></Field>
        <Field label="Charge"><Choice label={`Shipping rule ${i + 1} charge`} value={r.mode.kind} options={[['actual', 'Carrier cost'], ['adjusted', 'Carrier cost plus adjustment'], ['fixed', 'Fixed charge'], ['free', 'Free'], ['manual', 'Set by hand per invoice']]}
          onChange={v => update(d => { d.shipping.rules[i]!.mode = v === 'fixed' ? { kind: 'fixed', amount: '' } : v === 'adjusted' ? { kind: 'adjusted', fixed: '', markupBps: null as unknown as number } : { kind: v }; })} /></Field>
        {r.mode.kind === 'fixed' && <Field label="Fixed charge"><MoneyInput key={`${r.id}-fixed`} label={`Shipping rule ${i + 1} fixed charge`} value={r.mode.amount} onChange={v => update(d => { d.shipping.rules[i]!.mode = { kind: 'fixed', amount: v }; })} /></Field>}
        {r.mode.kind === 'adjusted' && <><Field label="Plus amount"><MoneyInput key={`${r.id}-plus`} label={`Shipping rule ${i + 1} plus amount`} value={r.mode.fixed} onChange={v => update(d => { const m = d.shipping.rules[i]!.mode; if (m.kind === 'adjusted') m.fixed = v; })} /></Field>
          <Field label="Plus percentage"><PercentInput key={`${r.id}-markup`} label={`Shipping rule ${i + 1} markup`} value={r.mode.markupBps} onChange={v => update(d => { const m = d.shipping.rules[i]!.mode; if (m.kind === 'adjusted') m.markupBps = v as number; })} /></Field></>}
        <Field label="Partial orders"><Choice label={`Shipping rule ${i + 1} partial orders`} value={r.chargingBasis} options={[['first_part', "Only the order's first shipment pays freight"], ['per_dispatch', 'Every shipment pays freight']]} onChange={v => update(d => { d.shipping.rules[i]!.chargingBasis = v; if (v === 'first_part') d.shipping.rules[i]!.freeThreshold = null; })} /></Field>
        {r.chargingBasis === 'per_dispatch' && <Field label="Free freight from (optional)" hint="Shipment value excluding tax, after discounts.">
          <MoneyInput key={`${r.id}-threshold`} label={`Shipping rule ${i + 1} free from`} value={r.freeThreshold?.amount ?? ''} onChange={v => update(d => { d.shipping.rules[i]!.freeThreshold = v === '' ? null : { amount: v, valueBasis: 'dispatch', afterDiscount: true, includesTax: false }; })} /></Field>}
        <button type="button" className={button} onClick={() => update(d => { d.shipping.rules.splice(i, 1); })}>Remove rule</button>
      </div>)}
      {draft.shipping.enabled && <button type="button" className={button} onClick={() => update(d => { d.shipping.rules.push({ id: nextId('freight', d.shipping.rules.map(x => x.id)), accountId: null, destination: null, priority: 0, mode: { kind: 'actual' }, chargingBasis: 'first_part', freeThreshold: null }); })}>Add shipping rule</button>}
    </fieldset>

    {issues.length > 0 && <div role="status" className="p-3 border rounded text-sm border-amber-300 bg-amber-50 text-amber-900">
      <p className="font-medium">Not ready to save yet:</p>
      <ul className="list-disc pl-5">{issues.map((x, i) => <li key={i}>{x.label}: {x.message}</li>)}</ul>
    </div>}

    <fieldset disabled={busy} className="space-y-3">
      <legend className="font-medium mb-2">Preview a retailer&apos;s charge</legend>
      <div className="grid md:grid-cols-4 gap-3">
        <Field label="Retailer"><Choice label="Preview retailer" value={request.accountId || null} options={accounts.map(a => [a.id, `${a.name}${a.taxExempt ? ' (tax exempt)' : ''}`])}
          onChange={v => setRequest(r => ({ ...r, accountId: v, taxExempt: accounts.find(a => a.id === v)?.taxExempt ?? false }))} /></Field>
        <Field label="Order date"><input aria-label="Preview order date" className={field} value={request.orderAt} onChange={e => setRequest(r => ({ ...r, orderAt: e.target.value }))} /></Field>
        <Field label="Dispatch date"><input aria-label="Preview dispatch date" className={field} value={request.dispatchAt} onChange={e => setRequest(r => ({ ...r, dispatchAt: e.target.value }))} /></Field>
        <Field label="Carrier cost (optional)" hint="Stands in for the shipment's stored carrier cost."><MoneyInput label="Preview carrier cost" value={request.carrierCost ?? ''} onChange={v => setRequest(r => ({ ...r, carrierCost: v && v !== 'invalid' ? v : null }))} /></Field>
        <Field label="Earlier parts of this order"><input aria-label="Preview earlier parts" className={field} inputMode="numeric" value={request.priorParts} onChange={e => setRequest(r => ({ ...r, priorParts: Math.max(0, Number(e.target.value) || 0) }))} /></Field>
      </div>
      {request.lines.map((l, i) => <div key={i} className="grid md:grid-cols-4 gap-3 items-end">
        <Field label="Product"><Choice label={`Preview line ${i + 1} product`} value={l.productId} options={productOptions} onChange={v => setRequest(r => ({ ...r, lines: r.lines.map((x, n) => n === i ? { ...x, productId: v, description: productName(v) } : x) }))} /></Field>
        <Field label="Ordered"><input aria-label={`Preview line ${i + 1} ordered`} className={field} inputMode="numeric" value={l.ordered} onChange={e => setRequest(r => ({ ...r, lines: r.lines.map((x, n) => n === i ? { ...x, ordered: Number(e.target.value) } : x) }))} /></Field>
        <Field label="In this dispatch"><input aria-label={`Preview line ${i + 1} dispatched`} className={field} inputMode="numeric" value={l.dispatched} onChange={e => setRequest(r => ({ ...r, lines: r.lines.map((x, n) => n === i ? { ...x, dispatched: Number(e.target.value) } : x) }))} /></Field>
        <button type="button" className={button} disabled={request.lines.length === 1} onClick={() => setRequest(r => ({ ...r, lines: r.lines.filter((_, n) => n !== i) }))}>Remove line</button>
      </div>)}
      <div className="flex gap-3">
        <button type="button" className={button} onClick={() => setRequest(r => ({ ...r, lines: [...r.lines, { productId: products[0]!.id, description: products[0]!.name, ordered: 1, dispatched: 1 }] }))}>Add line</button>
        <button type="button" className={button} disabled={!request.accountId} onClick={runPreview}>Preview this draft</button>
      </div>
      {preview && <PreviewResult title="This draft" result={preview.draft} money={money} accountName={accountName(request.accountId)} compare={preview.active} />}
    </fieldset>

    <fieldset disabled={busy || !props.canSave} className="space-y-3">
      <legend className="font-medium mb-2">Save as a new version</legend>
      <Field label="Reason for this change"><input aria-label="Reason for this change" className={field} value={reason} onChange={e => setReason(e.target.value)} /></Field>
      <button type="button" className={button} disabled={busy || !props.canSave || issues.length > 0 || reason.trim().length < 3} onClick={save}>Save new version</button>
      {serverIssues.length > 0 && <ul className="list-disc pl-5 text-sm text-red-900">{serverIssues.map((x, i) => <li key={i}>{x.label}: {x.message}</li>)}</ul>}
    </fieldset>

    {props.latest && !props.latest.activated && <fieldset disabled={busy || !props.canActivate} className="space-y-3 border-t pt-6 border-zinc-200 dark:border-zinc-800">
      <legend className="font-medium mb-2">Activate {props.latest.config.name} ({props.latest.versionKey}, revision {props.latest.revision})</legend>
      <p className={small}>Activation applies the saved version, not this page&apos;s draft. Preview it with the retailer and lines above; it is activated only if the server reproduces the same total.</p>
      <button type="button" className={button} disabled={!request.accountId} onClick={runLatestPreview}>Preview saved version</button>
      {latestPreview && <PreviewResult title="Saved version" result={latestPreview.result} money={(m: string) => `${props.latest!.config.currency} ${fromMinor(m)}`} accountName={accountName(request.accountId)} compare={null} />}
      <Field label="Reason for activating"><input aria-label="Reason for activating" className={field} value={activateReason} onChange={e => setActivateReason(e.target.value)} /></Field>
      <button type="button" className={button} disabled={busy || !props.canActivate || latestPreview?.result.status !== 'ready' || activateReason.trim().length < 3} onClick={activate}>Activate saved version</button>
    </fieldset>}
    {props.latest?.activated && <p className={small}>The latest saved version is activated. To change pricing, save a new version above.</p>}
  </section>;
}

function PreviewResult({ title, result, money, accountName, compare }: { title: string; result: Preview; money: (m: string) => string; accountName: string; compare: Preview | null }) {
  if (result.status === 'blocked') return <p role="status" className="p-3 border rounded text-sm border-red-300 bg-red-50 text-red-900">{title} cannot price this order: {result.reason}</p>;
  const s = result.snapshot;
  return <section className="space-y-2 text-sm" aria-label={`${title} preview`}>
    <h3 className="font-medium">{title}: {accountName}</h3>
    <table className="w-full text-left"><thead className="text-zinc-500"><tr><th className="py-1">Item</th><th>Qty</th><th>Base</th><th>Discount/unit</th><th>Unit</th><th>Amount</th></tr></thead><tbody>
      {s.lines.map(l => <tr key={l.lineId} className="border-t border-zinc-200 dark:border-zinc-800 align-top"><td className="py-1">{l.description}<span className={`block ${small}`}>{l.explanation}</span></td>
        <td>{l.dispatched}</td><td>{money(l.baseUnitPrice)}</td><td>{money(l.discountPerUnit)}</td><td>{money(l.unitPrice)}</td><td>{money(l.lineAmount)}</td></tr>)}
    </tbody></table>
    <p>Products {money(s.subtotal)} · Freight {money(s.freight.amount)} <span className={small}>({s.freight.explanation}; carrier cost {s.freight.carrier ? money(s.freight.carrier.cost) : 'not known'})</span></p>
    <p>Tax {money(s.tax.amount)}{s.tax.exempt ? ' (tax exempt)' : ''} · <strong>Total {money(s.total)}</strong> · Due {s.terms.dueDate}</p>
    {compare && (compare.status === 'ready'
      ? <p className={small}>The version in effect now charges {money(compare.snapshot.total)} for the same order ({BigInt(s.total) - BigInt(compare.snapshot.total) >= 0n ? '+' : '−'}{money((BigInt(s.total) > BigInt(compare.snapshot.total) ? BigInt(s.total) - BigInt(compare.snapshot.total) : BigInt(compare.snapshot.total) - BigInt(s.total)).toString())}).</p>
      : <p className={small}>The version in effect now cannot price this order: {compare.reason}</p>)}
  </section>;
}
