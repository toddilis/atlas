import { LoginForm } from './LoginForm';

// Server wrapper: reading searchParams keeps this route dynamic and lets the middleware
// pass status flags without client-side search-param plumbing.
export default function LoginPage({
  searchParams,
}: {
  searchParams: { denied?: string; unconfigured?: string };
}) {
  return (
    <div className="max-w-sm mx-auto py-16">
      <h1 className="text-lg font-semibold mb-1">Sign in</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-6">
        Atlas operator console
      </p>
      {searchParams.denied && (
        <p className="text-sm text-red-700 dark:text-red-400 mb-4">
          This account is not on the operator allowlist.
        </p>
      )}
      {searchParams.unconfigured && (
        <p className="text-sm text-amber-700 dark:text-amber-400 mb-4">
          Auth is not configured — set NEXT_PUBLIC_SUPABASE_URL,
          NEXT_PUBLIC_SUPABASE_ANON_KEY and ATLAS_OPERATOR_EMAILS.
        </p>
      )}
      <LoginForm />
    </div>
  );
}
