import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { authEnv, operatorAllowed } from './auth';
import WebSocket from 'ws';

export class OperatorAuthError extends Error {
  constructor(public readonly status: 401 | 403 | 503, message: string) {
    super(message);
    this.name = 'OperatorAuthError';
  }
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
    const origin = request.headers.get('origin');
    if (!origin || origin !== new URL(request.url).origin) {
      throw new OperatorAuthError(403, 'Same-origin request required.');
    }
  }
  const cookieStore = await cookies();
  const auth = createServerClient(env.url, env.anonKey, {
    realtime: { transport: WebSocket },
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
  return { actorId: user.id, email: user.email!, orgId };
}
