// Console auth helpers (PR-P, decision D3): Supabase Auth with cookie sessions gates the
// console; data access keeps using the server-side service-role client AFTER the gate.
// The anon key is the browser-safe credential used only for session handling — the
// service-role key never leaves the server (see lib/supabase.ts).

/**
 * Operator allowlist — fail closed. An empty/unset ATLAS_OPERATOR_EMAILS means nobody
 * can pass the gate, so a Supabase project with signups accidentally enabled still
 * admits no one. Comparison is case-insensitive on trimmed entries.
 */
export function operatorAllowed(
  email: string | null | undefined,
  configuredAllowlist = process.env.ATLAS_OPERATOR_EMAILS ?? '',
): boolean {
  const allowlist = configuredAllowlist
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length === 0) return false;
  return !!email && allowlist.includes(email.trim().toLowerCase());
}

export function normalizeProjectUrl(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    if (url.username || url.password || url.search || url.hash) return null;
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${url.origin}${pathname}`;
  } catch {
    return null;
  }
}

interface AuthEnvironmentSource {
  SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_URL?: string;
  NEXT_PUBLIC_SUPABASE_ANON_KEY?: string;
}

export function authEnv(
  env: AuthEnvironmentSource = process.env as AuthEnvironmentSource,
): { url: string; anonKey: string } | null {
  const publicUrl = normalizeProjectUrl(env.NEXT_PUBLIC_SUPABASE_URL);
  const serverUrl = normalizeProjectUrl(env.SUPABASE_URL);
  const anonKey = env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!publicUrl || !serverUrl || publicUrl !== serverUrl || !anonKey) return null;
  return { url: publicUrl, anonKey };
}
