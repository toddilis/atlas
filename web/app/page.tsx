import Link from 'next/link';

export default function HomePage() {
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold">Atlas operator console</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          Phase 2 — single operator, read-only for now. Authentication, write actions,
          and the conversational assistant arrive in later PRs.
        </p>
      </div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        <Link
          href="/approvals"
          className="block rounded-lg border border-zinc-200 dark:border-zinc-800 p-5 hover:border-zinc-400 dark:hover:border-zinc-600 transition"
        >
          <div className="font-semibold">Approvals</div>
          <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            Pending agent actions waiting on operator sign-off.
          </div>
        </Link>
      </div>
    </div>
  );
}
