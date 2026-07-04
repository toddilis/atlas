// Auth gate for every console route (PR-P). Session cookies are refreshed on each
// request; anyone without a session — or with a session whose email isn't on the
// operator allowlist — lands on /login. Fails closed: missing auth config blocks the
// console rather than opening it.

import { createServerClient } from '@supabase/ssr';
import { NextResponse, type NextRequest } from 'next/server';
import { authEnv, operatorAllowed } from './lib/auth';

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const isLogin = path === '/login' || path.startsWith('/login/');

  const env = authEnv();
  if (!env) {
    if (isLogin) return NextResponse.next({ request });
    return NextResponse.redirect(new URL('/login?unconfigured=1', request.url));
  }

  let response = NextResponse.next({ request });
  const supabase = createServerClient(env.url, env.anonKey, {
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
    if (isLogin) return response;
    return NextResponse.redirect(new URL('/login', request.url));
  }

  if (!operatorAllowed(user.email)) {
    await supabase.auth.signOut();
    return NextResponse.redirect(new URL('/login?denied=1', request.url));
  }

  if (isLogin) return NextResponse.redirect(new URL('/', request.url));
  return response;
}

export const config = {
  // Everything except Next static assets and the favicon. The signout route stays
  // inside the gate (signing out requires being signed in; harmless otherwise).
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
};
