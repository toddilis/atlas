// Console auth helpers (PR-P, decision D3): Supabase Auth with cookie sessions gates the
// console; data access keeps using the server-side service-role client AFTER the gate.
// The anon key is the browser-safe credential used only for session handling — the
// service-role key never leaves the server (see lib/supabase.ts).

/**
 * Operator allowlist — fail closed. An empty/unset ATLAS_OPERATOR_EMAILS means nobody
 * can pass the gate, so a Supabase project with signups accidentally enabled still
 * admits no one. Comparison is case-insensitive on trimmed entries.
 */
export function operatorAllowed(email: string | null | undefined): boolean {
  const allowlist = (process.env.ATLAS_OPERATOR_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
  if (allowlist.length === 0) return false;
  return !!email && allowlist.includes(email.toLowerCase());
}

export function authEnv(): { url: string; anonKey: string } | null {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}
