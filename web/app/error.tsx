'use client';

// Route-level error boundary (PR-N). Every page in the console is a server component
// that throws on query/env failure; without this file those throws surfaced as an
// unstyled Next.js 500 with no recovery path.

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <div className="max-w-xl mx-auto py-16 text-center">
      <h1 className="text-lg font-semibold mb-2">Something went wrong</h1>
      <p className="text-sm text-zinc-600 dark:text-zinc-400 mb-1">
        {error.message || 'The console could not load this page.'}
      </p>
      {error.digest && (
        <p className="text-xs text-zinc-500 dark:text-zinc-500 mb-4">ref {error.digest}</p>
      )}
      <button
        onClick={reset}
        className="text-sm px-3 py-1.5 rounded border border-zinc-300 dark:border-zinc-700 hover:bg-zinc-100 dark:hover:bg-zinc-800"
      >
        Try again
      </button>
    </div>
  );
}
