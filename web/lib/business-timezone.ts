// The business's calendar for aging (0044, CLOSE-01e). The timezone comes from the active
// pricing configuration at the as-of instant — the same configuration that priced the
// invoices being aged (PORT-01). A business with no active pricing cannot have drafted
// BILL invoices, so only then does the database default apply (null). Any other
// resolution error is surfaced, never papered over with a default calendar.

import 'server-only';
import { supabaseServer } from './supabase';
import { selectPricingVersion } from '../../src/platform/pricing/versioned';

export async function businessTimezone(orgId: string, asOfIso: string): Promise<string | null> {
  const sb = await supabaseServer();
  const { data, error } = await sb.from('pricing_activations').select('version:pricing_versions!inner(config)').eq('org_id', orgId);
  if (error) throw error;
  const configs = (data ?? []).map(row => (row as unknown as { version: { config: unknown } }).version.config);
  if (configs.length === 0) return null;
  try {
    return selectPricingVersion(configs, orgId, asOfIso).timezone;
  } catch (cause) {
    if (cause instanceof Error && cause.message.includes('no effective configuration')) return null;
    throw cause;
  }
}
