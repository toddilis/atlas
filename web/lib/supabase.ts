// Supabase server client for the operator console. Service-role key bypasses RLS so
// the operator can see every row in their org without needing the GUC app.org_id to
// be set. v1 is single-operator + service-role only; auth-scoped client arrives with
// the auth PR.
//
// IMPORTANT: never expose this client to client components. All data access on the
// console runs through server components (the default in App Router) so the service
// role key never ships to the browser.

import 'server-only';
import { createClient, SupabaseClient } from '@supabase/supabase-js';

let cached: SupabaseClient | null = null;

export function supabaseServer(): SupabaseClient {
  if (cached) return cached;
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      'SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set (web/.env.local)',
    );
  }
  cached = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    db: { schema: 'public' },
  });
  return cached;
}

export function orgId(): string {
  const id = process.env.ATLAS_ORG_ID;
  if (!id) throw new Error('ATLAS_ORG_ID must be set (web/.env.local)');
  return id;
}
