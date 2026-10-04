import { createServerClient } from '@supabase/ssr';
import { cookies } from 'next/headers';
import { NextResponse } from 'next/server';
import { authEnv } from '../../../lib/auth';
import WebSocket from 'ws';
import type { RealtimeClientOptions } from '@supabase/supabase-js';

export async function POST(request: Request) {
  if (request.headers.get('origin') !== new URL(request.url).origin) {
    return NextResponse.json({ error: 'Same-origin request required.' }, { status: 403 });
  }
  const env = authEnv();
  if (env) {
    const cookieStore = await cookies();
    const supabase = createServerClient(env.url, env.anonKey, {
      realtime: { transport: WebSocket as unknown as RealtimeClientOptions['transport'] },
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (cookiesToSet) =>
          cookiesToSet.forEach(({ name, value, options }) =>
            cookieStore.set(name, value, options),
          ),
      },
    });
    await supabase.auth.signOut();
  }
  return NextResponse.redirect(new URL('/login', request.url), { status: 302 });
}
