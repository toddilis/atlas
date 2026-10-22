// Console catalogue actions (0040): create or edit a product or retailer. The operator
// is verified here (session, allowlist, same origin); the database enforces action
// pause, the business's catalog.save / accounts.save grants, duplicates, stale edits,
// synced-sku and fixed-currency protection, and records the audit row. The browser gets
// back a fixed outcome code, never raw text.

import 'server-only';
import { OperatorAuthError, requireOperator } from './auth-server';
import { supabaseServer } from './supabase';
import { catalogOutcomeFor, type CatalogOutcome } from './catalog';

// Relative Location: request.url names Next's own hostname, not the browser's.
const back = (outcome: CatalogOutcome) => new Response(null, { status: 303, headers: { Location: `/catalog?outcome=${outcome}` } });
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function operatorFor(request: Request) {
  try { return { operator: await requireOperator(request) }; }
  catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    if (error.status === 401) return { refused: new Response(null, { status: 303, headers: { Location: '/login' } }) };
    return { refused: Response.json({ error: error.message }, { status: error.status }) };
  }
}
const text = (form: FormData, name: string): string => {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
};
/** '' means create; otherwise it must be a well-formed id and, on edit, the loaded
 * row's updated_at must come with it so a stale page cannot overwrite a newer change. */
function editTarget(form: FormData, idField: string): { id: string | null; expected: string | null } | 'bad' {
  const id = text(form, idField);
  if (id === '') return { id: null, expected: null };
  if (!UUID.test(id)) return 'bad';
  const expected = text(form, 'expected_updated_at');
  if (expected === '' || Number.isNaN(Date.parse(expected))) return 'bad';
  return { id, expected };
}

function refusedBy(error: { message: string }, action: string) {
  const outcome = catalogOutcomeFor(error.message);
  if (outcome === 'failed') console.error('catalog.save_failed', { action, error: error.message });
  return back(outcome);
}

export async function saveProductAction(request: Request) {
  const { operator, refused } = await operatorFor(request);
  if (!operator) return refused;
  const form = await request.formData();
  const target = editTarget(form, 'product_id');
  if (target === 'bad') return back('not_found');
  const sku = text(form, 'sku'), displayName = text(form, 'display_name'), unit = text(form, 'unit');
  if (!sku || !displayName || !unit || sku.length > 64 || displayName.length > 200 || unit.length > 32) return back('invalid');
  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_save_product', {
    p_org_id: operator.orgId, p_product_id: target.id as unknown as string, p_sku: sku, p_display_name: displayName,
    p_unit: unit, p_active: form.get('active') === 'on', p_expected_updated_at: target.expected as unknown as string,
    p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  return error ? refusedBy(error, 'product') : back('product_saved');
}

export async function saveRetailerAction(request: Request) {
  const { operator, refused } = await operatorFor(request);
  if (!operator) return refused;
  const form = await request.formData();
  const target = editTarget(form, 'account_id');
  if (target === 'bad') return back('not_found');
  const name = text(form, 'name'), currency = text(form, 'currency').toUpperCase();
  const email = text(form, 'billing_email'), status = text(form, 'status') || 'active';
  const terms = Number.parseInt(text(form, 'payment_terms_days'), 10);
  if (!name || name.length > 200 || !/^[A-Z]{3}$/.test(currency) || !Number.isSafeInteger(terms) || terms < 0 || terms > 365
    || !['active', 'dormant', 'closed'].includes(status) || email.length > 200) return back('invalid');
  const sb = await supabaseServer();
  const { error } = await sb.rpc('operator_save_account', {
    p_org_id: operator.orgId, p_account_id: target.id as unknown as string, p_name: name, p_currency: currency,
    p_tax_exempt: form.get('tax_exempt') === 'on', p_payment_terms_days: terms,
    p_billing_email: (email || null) as unknown as string, p_status: status,
    p_expected_updated_at: target.expected as unknown as string,
    p_actor_id: operator.actorId, p_actor_email: operator.email,
  });
  return error ? refusedBy(error, 'retailer') : back('retailer_saved');
}
