// Auth gate for every console route (PR-P). Session cookies are refreshed on each
// request; anyone without a session — or with a session whose email isn't on the
// operator allowlist — lands on /login. Fails closed: missing auth config blocks the
// console rather than opening it.

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { authEnv, operatorAllowed } from './lib/auth';
import { redirectWithCookies } from './lib/auth-response';
import WebSocket from 'ws';
import type { RealtimeClientOptions } from '@supabase/supabase-js';

export async function proxy(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isLogin = path === '/login' || path.startsWith('/login/');
  const isApi = path.startsWith('/api/');

  const env = authEnv();
  if (!env) {
    if (isApi) return NextResponse.json({ error: 'Operator access is not configured.' }, { status: 503 });
    if (isLogin) return NextResponse.next({ request });
    return NextResponse.redirect(new URL('/login?unconfigured=1', request.url));
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(env.url, env.anonKey, {
    realtime: { transport: WebSocket as unknown as RealtimeClientOptions['transport'] },
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (cookiesToSet) => {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        response = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) =>
          response.cookies.set(name, value, options),
        );
      },
    },
  });

  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    if (isApi) {
      const denied = NextResponse.json({ error: 'Sign in required.' }, { status: 401 });
      for (const cookie of response.cookies.getAll()) denied.cookies.set(cookie);
      return denied;
    }
    if (isLogin) return response;
    return redirectWithCookies(new URL('/login', request.url), response);
  }

  if (!operatorAllowed(user.email)) {
    await supabase.auth.signOut();
    if (isApi) {
      const denied = NextResponse.json({ error: 'Operator access denied.' }, { status: 403 });
      for (const cookie of response.cookies.getAll()) denied.cookies.set(cookie);
      return denied;
    }
    return redirectWithCookies(new URL('/login?denied=1', request.url), response);
  }

  if (isLogin) return redirectWithCookies(new URL('/', request.url), response);
  return response;
}

export const config = {
  // Everything except Next static assets and the favicon. The signout route stays
  // inside the gate (signing out requires being signed in; harmless otherwise).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
