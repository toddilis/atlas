import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { cookies } from 'next/headers';
import { authEnv, operatorAllowed, sameOriginRequest } from './auth';
import WebSocket from 'ws';
import type { RealtimeClientOptions } from '@supabase/supabase-js';

export class OperatorAuthError extends Error {
  constructor(public readonly status: 401 | 403 | 503, message: string) {
    super(message);
    this.name = 'OperatorAuthError';
  }
}

// A raw service client for the membership check only. supabaseServer() itself calls
// requireOperator, so authority checks cannot go through it.
let membershipClient: SupabaseClient | null = null;
function membership(): SupabaseClient {
  if (membershipClient) return membershipClient;
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new OperatorAuthError(503, 'Operator access is not configured.');
  membershipClient = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
    realtime: { transport: WebSocket as unknown as RealtimeClientOptions['transport'] },
  });
  return membershipClient;
}

/** The business's own membership (0049), enforced on top of the environment allowlist:
 * while the business has no member rows the allowlist alone admits operators
 * (bootstrap mode); once rows exist, only an enabled member passes. Membership can
 * narrow access, never widen it. A failed read fails closed. */
async function memberAllowed(orgId: string, email: string): Promise<boolean> {
  const { data, error } = await membership().from('org_members').select('email, enabled').eq('org_id', orgId);
  if (error) throw new OperatorAuthError(503, 'Membership could not be checked.');
  if ((data ?? []).length === 0) return true;
  const normalized = email.trim().toLowerCase();
  return (data ?? []).some(row => row.email === normalized && row.enabled);
}

/** Verified identity for this single-business pilot, never request-body identity.
 * A shared-business deployment additionally needs membership-scoped data access.
 */
export async function requireOperator(request?: Request) {
  const env = authEnv();
  const orgId = process.env.ATLAS_ORG_ID;
  if (!env || !orgId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(orgId)) {
    throw new OperatorAuthError(503, 'Operator access is not configured.');
  }
  if (request && !['GET', 'HEAD', 'OPTIONS'].includes(request.method.toUpperCase())) {
    if (!sameOriginRequest(request.headers)) {
      throw new OperatorAuthError(403, 'Same-origin request required.');
    }
  }
  const cookieStore = await cookies();
  const auth = createServerClient(env.url, env.anonKey, {
    realtime: { transport: WebSocket as unknown as RealtimeClientOptions['transport'] },
    cookies: {
      getAll: () => cookieStore.getAll(),
      setAll: (updates) => {
        try { updates.forEach(({ name, value, options }) => cookieStore.set(name, value, options)); }
        catch { /* Server components cannot write cookies; proxy handles refresh. */ }
      },
    },
  });
  const { data: { user }, error } = await auth.auth.getUser();
  if (error || !user) throw new OperatorAuthError(401, 'Sign in required.');
  if (!operatorAllowed(user.email)) throw new OperatorAuthError(403, 'Operator access denied.');
  if (!(await memberAllowed(orgId, user.email!))) throw new OperatorAuthError(403, 'Operator access denied.');
  return { actorId: user.id, email: user.email!, orgId };
}
