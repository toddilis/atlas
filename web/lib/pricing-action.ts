// Console pricing actions (save, activate). The operator is verified here (session,
// allowlist, same origin) and the draft is checked against the pricing schema with the
// business forced to the operator's own; the database function enforces action pause, the
// business's operator grant, the expected revision and that every product and retailer is
// this business's, and records who acted and why (0033). The browser gets back a fixed
// outcome code (plus the schema's field messages for an invalid draft), never raw errors.

import 'server-only';
import { OperatorAuthError, requireOperator } from './auth-server';
import { supabaseServer } from './supabase';
import { PricingConfigSchema, PricingInputSchema, calculatePricing } from '../../src/platform/pricing/versioned';
import { issueLabel, pricingOutcomeFor, type PricingOutcome } from './pricing';

const reply = (status: number, outcome: PricingOutcome | 'signed_out' | 'denied', extra: Record<string, unknown> = {}) =>
  Response.json({ outcome, ...extra }, { status });
const STATUS: Partial<Record<PricingOutcome, number>> = { stale: 409, stale_activation: 409, version_taken: 409, timeline: 409,
  preview_changed: 409, paused: 423, not_allowed: 403, invalid: 422, unknown_reference: 422, reason: 422 };

async function operatorFor(request: Request) {
  try { return { operator: await requireOperator(request) }; }
  catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    return { refused: reply(error.status, error.status === 401 ? 'signed_out' : 'denied') };
  }
}
async function bodyOf(request: Request): Promise<Record<string, unknown> | null> {
  const body = await request.json().catch(() => null);
  return body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
}
const validReason = (reason: unknown): reason is string => typeof reason === 'string' && reason.trim().length >= 3 && reason.length <= 500;
const issuesOf = (error: { issues: Array<{ path: Array<string | number>; message: string }> }) =>
  error.issues.slice(0, 20).map(i => ({ label: issueLabel(i.path), message: i.message }));

function refusedBy(error: { message: string }, action: string) {
  const outcome = pricingOutcomeFor(error.message);
  if (outcome === 'failed') console.error('pricing.action_failed', { action, error: error.message });
  return reply(STATUS[outcome] ?? 500, outcome);
}

export async function savePricing(request: Request) {
  const { operator, refused } = await operatorFor(request);
  if (!operator) return refused;
  const body = await bodyOf(request);
  if (!body || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision as number) < 0) return reply(400, 'failed');
  if (!validReason(body.reason)) return reply(422, 'reason');
  const config = body.config && typeof body.config === 'object' ? body.config : {};
  // The business is the operator's, whatever the page sent.
  const parsed = PricingConfigSchema.safeParse({ ...config, businessId: operator.orgId });
  if (!parsed.success) return reply(422, 'invalid', { issues: issuesOf(parsed.error) });
  const sb = await supabaseServer();
  const { data, error } = await sb.rpc('operator_save_pricing_version', {
    p_org_id: operator.orgId, p_expected_revision: body.expectedRevision, p_config: parsed.data,
    p_actor_id: operator.actorId, p_actor_email: operator.email, p_reason: body.reason.trim(),
  });
  if (error) return refusedBy(error, 'save');
  return reply(200, 'saved', { versionId: data });
}

export async function activatePricing(request: Request) {
  const { operator, refused } = await operatorFor(request);
  if (!operator) return refused;
  const body = await bodyOf(request);
  if (!body || typeof body.versionId !== 'string' || !Number.isSafeInteger(body.expectedRevision) || typeof body.previewTotal !== 'string') return reply(400, 'failed');
  if (!validReason(body.reason)) return reply(422, 'reason');
  const sb = await supabaseServer();
  const { data: version, error: loadError } = await sb.from('pricing_versions').select('id,revision,config')
    .eq('org_id', operator.orgId).eq('id', body.versionId).maybeSingle();
  if (loadError) return refusedBy(loadError, 'activate');
  if (!version) return reply(409, 'stale_activation');
  // The stored version, not the page's copy, must reproduce the preview the operator checked.
  const config = PricingConfigSchema.safeParse(version.config);
  if (!config.success) return reply(422, 'invalid', { issues: issuesOf(config.error) });
  const input = PricingInputSchema.safeParse({ ...(body.previewInput as object), businessId: operator.orgId });
  if (!input.success) return reply(409, 'preview_changed');
  let total: string;
  try { total = calculatePricing(config.data, input.data).total; } catch { return reply(409, 'preview_changed'); }
  if (total !== body.previewTotal) return reply(409, 'preview_changed');
  const { error } = await sb.rpc('operator_activate_pricing_version', {
    p_org_id: operator.orgId, p_version_id: version.id, p_expected_revision: body.expectedRevision,
    p_actor_id: operator.actorId, p_actor_email: operator.email, p_reason: body.reason.trim(),
  });
  if (error) return refusedBy(error, 'activate');
  return reply(200, 'activated');
}
