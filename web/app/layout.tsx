import type { Metadata } from 'next';
import Link from 'next/link';
import './globals.css';

export const metadata: Metadata = {
  title: 'Atlas Console',
  description: 'Atlas operator console — Phase 2.',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="min-h-screen flex flex-col">
          <header className="border-b border-zinc-200 dark:border-zinc-800">
            <div className="max-w-6xl mx-auto px-6 py-4 flex items-center gap-6">
              <Link href="/" className="font-semibold text-lg">
                Atlas
              </Link>
              <nav className="flex gap-4 text-sm text-zinc-600 dark:text-zinc-400">
                <Link href="/approvals" className="hover:text-zinc-900 dark:hover:text-zinc-100">
                  Approvals
                </Link>
                <Link href="/invoices" className="hover:text-zinc-900 dark:hover:text-zinc-100">
                  Invoices
                </Link>
                <Link href="/statements" className="hover:text-zinc-900 dark:hover:text-zinc-100">
                  Statements
                </Link>
              </nav>
            </div>
          </header>
          <main className="flex-1 max-w-6xl mx-auto w-full px-6 py-8">{children}</main>
          <footer className="border-t border-zinc-200 dark:border-zinc-800">
            <div className="max-w-6xl mx-auto px-6 py-3 text-xs text-zinc-500 dark:text-zinc-500">
              Phase 2 · operator console
            </div>
          </footer>
        </div>
      </body>
    </html>
  );
}
