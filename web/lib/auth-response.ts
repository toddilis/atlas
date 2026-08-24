import { NextResponse } from 'next/server';

/**
 * Build a redirect without losing cookies written while Supabase refreshed or cleared
 * the session. Returning a fresh redirect directly would discard those cookie writes.
 */
export function redirectWithCookies(
  destination: URL,
  cookieResponse: NextResponse,
  status: 302 | 303 | 307 | 308 = 307,
): NextResponse {
  const redirect = NextResponse.redirect(destination, { status });
  for (const cookie of cookieResponse.cookies.getAll()) redirect.cookies.set(cookie);
  return redirect;
}
