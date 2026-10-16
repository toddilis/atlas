import { supabase } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';
import { PricingConfigSchema, PricingInputSchema, calculatePricing } from './versioned.js';
import { selectPricingVersion } from './configuration.js';

/** Internal persistence adapter. Public/operator callers must enter via AUTHZ's
 * invokeTool and a verified business binding; this module grants no authority. */
export async function savePricingVersion(businessId: string, actor: string, expectedRevision: number, configValue: unknown, reason: string) {
  const config = PricingConfigSchema.parse(configValue);
  if (config.businessId !== businessId) throw new Error('pricing: cross-business configuration refused');
  const { data, error } = await supabase().rpc('save_pricing_version', {
    p_org_id: businessId, p_expected_revision: expectedRevision, p_config: config as unknown as Json, p_actor: actor, p_reason: reason,
  });
  if (error) throw error;
  return data;
}

export async function loadActivePricing(businessId: string, pricingAt: string) {
  const { data, error } = await supabase().from('pricing_activations').select('version_id,pricing_versions!inner(*)').eq('org_id', businessId);
  if (error) throw error;
  const versions = (data ?? []).map(row => row.pricing_versions);
  const chosen = selectPricingVersion(versions.map(v => v.config), businessId, pricingAt);
  const row = versions.find(v => v.version_key === chosen.version)!;
  return { id: row.id, revision: row.revision, config: chosen };
}

/** Saved version preview shares the exact BILL calculator. No activation or provider effect. */
export async function previewSavedPricing(businessId: string, versionId: string, inputValue: unknown) {
  const input = PricingInputSchema.parse(inputValue);
  if (input.businessId !== businessId) throw new Error('pricing: cross-business preview refused');
  const { data, error } = await supabase().from('pricing_versions').select('*').eq('org_id', businessId).eq('id',versionId).single();
  if (error) throw error;
  return { versionId, revision: data.revision, snapshot: calculatePricing(data.config,input) };
}

export async function activatePricingVersion(businessId: string, actor: string, versionId: string, expectedRevision: number, previewInput: unknown, reason: string) {
  // Re-read configuration and calculate at the trusted boundary. No submitted total
  // or client-generated snapshot is used as activation evidence.
  const preview = await previewSavedPricing(businessId,versionId,previewInput);
  if (preview.revision !== expectedRevision) throw new Error('pricing: stale preview revision');
  const { data, error } = await supabase().rpc('activate_pricing_version', {
    p_org_id: businessId,p_version_id: versionId,p_expected_revision: expectedRevision,p_actor: actor,p_reason: reason,
  });
  if (error) throw error;
  return { activationId: data, preview };
}
