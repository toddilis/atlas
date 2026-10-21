// Assistant — read-only questions over the business's own records (AI-01, PR-T). Answers
// come from whitelisted queries; the citations under each answer are the queries that were
// actually run, built by code. The records pages stay the source of truth.

import Link from 'next/link';
import { supabaseServer, orgId } from '@/lib/supabase';
import { ASSISTANT_OUTCOMES, isAssistantOutcome } from '@/lib/assistant';
import type { Citation } from '@/lib/assistant-tools';

export const dynamic = 'force-dynamic';

interface ExchangeRow {
  id: string;
  asked_by_email: string;
  question: string;
  answer: string | null;
  citations: Citation[];
  model: string;
  status: 'ok' | 'failed';
  error: string | null;
  created_at: string;
}

async function loadAssistant() {
  const sb = await supabaseServer();
  const org = orgId();
  const [exchanges, grants, controls] = await Promise.all([
    sb.from('assistant_exchanges').select('id, asked_by_email, question, answer, citations, model, status, error, created_at')
      .eq('org_id', org).order('created_at', { ascending: false }).limit(10),
    sb.from('tool_grants').select('enabled, risk').eq('org_id', org).eq('agent_name', 'operator').eq('tool_name', 'assistant.ask'),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
  ]);
  for (const r of [exchanges, grants, controls]) if (r.error) throw r.error;
  const paused = Boolean(controls.data?.paused);
  const granted = (grants.data ?? []).some(g => g.enabled && g.risk !== 'approve_required');
  const keyed = Boolean(process.env.ANTHROPIC_API_KEY?.trim());
  return {
    exchanges: (exchanges.data ?? []) as ExchangeRow[],
    ask: granted && !paused && keyed,
    note: paused ? 'Business actions are paused, so the assistant is off until they are resumed.'
      : !granted ? 'The assistant is switched off for this business. It is turned on deliberately with the operator assistant.ask grant — the model-spend switch.'
      : !keyed ? 'No model is configured on the console host (ANTHROPIC_API_KEY), so questions cannot be asked here.' : null,
  };
}

function refHref(row: Citation['rows'][number]): string {
  switch (row.kind) {
    case 'approval': return '/approvals';
    case 'job': return '/jobs';
    case 'invoice': return `/invoices/${row.id}`;
  }
}

function relativeTime(iso: string): string {
  const m = Math.floor((Date.now() - new Date(iso).getTime()) / 60_000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.floor(h / 24)}d ago`;
}

export default async function AssistantPage({ searchParams }: { searchParams: Promise<{ outcome?: string }> }) {
  const { outcome } = await searchParams;
  const notice = isAssistantOutcome(outcome) ? ASSISTANT_OUTCOMES[outcome] : null;
  const { exchanges, ask, note } = await loadAssistant();

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Assistant</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">
          Read-only questions over this business&apos;s records. Every answer cites the queries it ran; figures are checked against the queried rows.
        </p>
      </div>

      {notice ? (
        <div data-testid="assistant-notice" role="status" className={`rounded-lg border p-4 text-sm ${notice.ok
          ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
          : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'}`}>
          {notice.text}
        </div>
      ) : null}

      {note ? (
        <div data-testid="assistant-note" className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 text-sm text-zinc-600 dark:text-zinc-400">{note}</div>
      ) : null}

      {ask ? (
        <form method="post" action="/assistant/ask" className="flex items-end gap-2">
          <label className="flex-1 text-sm">
            <span className="block text-xs font-semibold text-zinc-500 uppercase tracking-wide">Question</span>
            <input name="question" required maxLength={1000} placeholder="Which invoices are overdue?"
              className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1.5 text-sm" />
          </label>
          <button type="submit" className="rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-3 py-1.5 text-sm font-medium">
            Ask
          </button>
        </form>
      ) : null}

      <section className="space-y-3" aria-label="Recent questions">
        <h2 className="text-lg font-semibold">Recent questions</h2>
        {exchanges.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center text-zinc-500">
            Nothing asked yet.
          </div>
        ) : (
          exchanges.map(exchange => (
            <div key={exchange.id} className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-5" data-testid="exchange">
              <div className="flex items-start justify-between gap-4 text-sm">
                <div className="font-medium">{exchange.question}</div>
                <div className="text-right text-xs text-zinc-500 whitespace-nowrap">
                  <div>{exchange.asked_by_email}</div>
                  <div className="mt-0.5">{relativeTime(exchange.created_at)}</div>
                </div>
              </div>
              {exchange.status === 'ok' ? (
                <p className="mt-3 text-sm text-zinc-800 dark:text-zinc-200">{exchange.answer}</p>
              ) : (
                <p className="mt-3 text-sm text-zinc-500">
                  Not answered: the attempt was recorded without an answer (the model declined, failed, or introduced an ungrounded figure).
                </p>
              )}
              {(exchange.citations ?? []).length > 0 ? (
                <div className="mt-3">
                  <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Queried</div>
                  <div className="mt-1 space-y-1 text-xs text-zinc-600 dark:text-zinc-400">
                    {exchange.citations.map((citation, index) => (
                      <div key={index}>
                        <span className="font-mono">{citation.tool}</span>
                        {citation.rows.slice(0, 5).map(row => (
                          <Link key={`${row.kind}:${row.id}`} href={refHref(row)} className="ml-2 underline-offset-2 hover:underline">{row.label}</Link>
                        ))}
                        {citation.rows.length === 0 ? <span className="ml-2">no matching rows</span> : null}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}
            </div>
          ))
        )}
      </section>
    </div>
  );
}
