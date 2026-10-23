// The business's own membership check (0049), shared by the request proxy and
// requireOperator. No 'server-only' marker: the proxy (middleware) imports it too.
// While the business has no member rows the environment allowlist alone admits
// operators (bootstrap mode); once rows exist, only an enabled member passes.
// Membership can narrow access, never widen it.

import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import WebSocket from 'ws';
import type { RealtimeClientOptions } from '@supabase/supabase-js';

let client: SupabaseClient | null = null;
function membershipClient(): SupabaseClient | null {
  if (client) return client;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  client = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket as unknown as RealtimeClientOptions['transport'] },
  });
  return client;
}

/** True when the email passes the business's membership; 'unavailable' when the check
 * itself cannot run (missing service configuration or a failed read) — the caller
 * decides how that fails closed. */
export async function memberAllowed(orgId: string, email: string): Promise<boolean | 'unavailable'> {
  const sb = membershipClient();
  if (!sb) return 'unavailable';
  const { data, error } = await sb.from('org_members').select('email, enabled').eq('org_id', orgId);
  if (error) return 'unavailable';
  if ((data ?? []).length === 0) return true;
  const normalized = email.trim().toLowerCase();
  return (data ?? []).some(row => row.email === normalized && row.enabled);
}
