import 'server-only';
import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { authEnv, operatorAllowed } from './auth';

/** Revalidate at each privileged boundary, including requests that bypass the proxy. */
export async function requireOperator() {
  const env = authEnv();
  if (!env) redirect('/login?unconfigured=1');
  const jar = await cookies();
  const client = createServerClient(env.url, env.anonKey, {
    cookies: {
      getAll: () => jar.getAll(),
      // Server components cannot write cookies; the proxy owns session refresh.
      setAll: () => {},
    },
  });
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) redirect('/login');
  if (!operatorAllowed(user.email)) redirect('/login?denied=1');
  return user;
}
