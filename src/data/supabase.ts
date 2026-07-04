import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './database.types.js';

let cached: SupabaseClient<Database> | null = null;

/**
 * Typed service-role client (PR-M): queries and RPC calls are checked against the
 * generated schema in database.types.ts, so a renamed column or dropped RPC fails
 * `tsc` instead of failing at runtime. Regenerate types after adding a migration:
 * `npm run gen:types`.
 */
export function supabase(): SupabaseClient<Database> {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error('SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set');
  }
  cached = createClient<Database>(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
  });
  return cached;
}

export function orgId(): string {
  const id = process.env.ATLAS_ORG_ID;
  if (!id) throw new Error('ATLAS_ORG_ID must be set');
  return id;
}
