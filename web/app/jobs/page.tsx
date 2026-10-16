// Background jobs — what the worker could not finish on its own (JOBS-01, migration 0029).
// Read-only: blocked and quarantined jobs with their reason and what to do, jobs waiting
// to retry, and whether the worker is picking up due work at all.

import { supabaseServer, orgId } from '@/lib/supabase';
import { formatDateTime, relativeTime } from '@/lib/format';
import { Badge, type BadgeTone } from '@/components/Badge';
import {
  adviceFor, isRetryOutcome, kindLabel, MAX_ATTEMPTS, nextStep, RETRY_OUTCOMES, runsByJob, summarize,
  type JobRow, type JobRunRow, type JobState,
} from '@/lib/jobs';

export const dynamic = 'force-dynamic';

interface DispatchInfo {
  sourceDispatchKey: string;
  orderName: string | null;
  trackingNumbers: string[];
}

async function loadJobs() {
  const sb = await supabaseServer();
  const org = orgId();
  const [jobs, succeeded, runs, grant, controls] = await Promise.all([
    sb.from('scheduled_jobs')
      .select('job_key, kind, state, attempts, next_attempt_at, lease_until, last_error, created_at, updated_at, dispatch_id')
      .eq('org_id', org).neq('state', 'succeeded').order('updated_at', { ascending: false }).limit(500),
    sb.from('scheduled_jobs').select('job_key', { count: 'exact', head: true }).eq('org_id', org).eq('state', 'succeeded'),
    sb.from('job_runs').select('job_key, attempt, outcome, finished_at, detail')
      .eq('org_id', org).order('finished_at', { ascending: false }).limit(300),
    sb.from('tool_grants').select('enabled').eq('org_id', org).eq('agent_name', 'operator').eq('tool_name', 'jobs.retry').maybeSingle(),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
  ]);
  for (const r of [jobs, succeeded, runs, grant, controls]) if (r.error) throw r.error;
  // Shown so the operator knows before trying; the database enforces both on every retry.
  const retryBlockedBy = controls.data?.paused ? 'Business actions are paused, so jobs cannot be retried until they are resumed.'
    : !grant.data?.enabled ? 'Retrying jobs is switched off for this business (the operator jobs.retry grant is missing or revoked).' : null;
  const rows = (jobs.data ?? []) as JobRow[];
  const dispatchIds = [...new Set(rows.map(j => j.dispatch_id))];
  const dispatches = new Map<string, DispatchInfo>();
  if (dispatchIds.length) {
    const [d, f] = await Promise.all([
      sb.from('dispatches').select('id, source_dispatch_key').eq('org_id', org).in('id', dispatchIds),
      sb.from('shopify_fulfillments').select('dispatch_id, tracking_numbers, order:shopify_orders(shopify_order_name)')
        .eq('org_id', org).in('dispatch_id', dispatchIds),
    ]);
    if (d.error) throw d.error;
    if (f.error) throw f.error;
    const fulfillments = new Map(((f.data ?? []) as unknown as Array<{
      dispatch_id: string; tracking_numbers: string[]; order: { shopify_order_name: string | null } | null;
    }>).map(x => [x.dispatch_id, x]));
    for (const row of (d.data ?? []) as Array<{ id: string; source_dispatch_key: string }>) {
      const ful = fulfillments.get(row.id);
      dispatches.set(row.id, {
        sourceDispatchKey: row.source_dispatch_key,
        orderName: ful?.order?.shopify_order_name ?? null,
        trackingNumbers: ful?.tracking_numbers ?? [],
      });
    }
  }
  return { rows, succeeded: succeeded.count ?? 0, runs: (runs.data ?? []) as JobRunRow[], dispatches, retryBlockedBy };
}

const STATE_TONE: Record<JobState, BadgeTone> = {
  pending: 'zinc', running: 'blue', succeeded: 'green', failed: 'amber', blocked: 'red', quarantined: 'red',
};

export default async function JobsPage({ searchParams }: { searchParams: Promise<{ retry?: string }> }) {
  const now = new Date();
  const { retry } = await searchParams;
  const notice = isRetryOutcome(retry) ? RETRY_OUTCOMES[retry] : null;
  const { rows, succeeded, runs, dispatches, retryBlockedBy } = await loadJobs();
  const summary = summarize(rows, runs, now);
  summary.counts.succeeded = succeeded;
  const history = runsByJob(runs);
  const total = rows.length + succeeded;

  return (
    <div className="space-y-8">
      <div className="flex items-baseline justify-between gap-4">
        <h1 className="text-2xl font-semibold">Background jobs</h1>
        <div className="text-sm text-zinc-500" data-testid="last-run">
          {summary.lastRunAt ? <>Last worker run {relativeTime(summary.lastRunAt)}</> : 'No worker runs recorded yet'}
        </div>
      </div>

      {notice ? (
        <div data-testid="retry-notice" role="status" className={`rounded-lg border p-4 text-sm ${notice.ok
          ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
          : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'}`}>
          {notice.text}
        </div>
      ) : null}

      {total === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center text-zinc-500">
          No background jobs yet. Carrier cost jobs appear once the worker runs with GoSweetSpot
          configured and a tracked Shopify dispatch still needs its shipping cost.
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2 text-sm" aria-label="Job counts">
            {(['quarantined', 'blocked', 'failed', 'running', 'pending', 'succeeded'] as JobState[]).map(state => (
              <span key={state} className="inline-flex items-center gap-1.5 rounded border border-zinc-200 dark:border-zinc-800 px-2 py-1">
                <Badge tone={STATE_TONE[state]}>{state === 'failed' ? 'retrying' : state}</Badge>
                <span className="tabular-nums">{summary.counts[state]}</span>
              </span>
            ))}
          </div>

          {summary.overdue.length > 0 ? (
            <div role="alert" data-testid="overdue" className="rounded-lg border border-amber-300 bg-amber-50 dark:border-amber-800 dark:bg-amber-950/40 p-4 text-sm text-amber-900 dark:text-amber-200">
              {summary.overdue.length} {summary.overdue.length === 1 ? 'job is' : 'jobs are'} overdue by more than
              10 minutes. Check that the worker is running and that GOSWEETSPOT_ACCESS_KEY is still set on it.
            </div>
          ) : null}

          <Section title="Needs a person" empty="Nothing is blocked. Every job is running, retrying or done.">
            {summary.needsAttention.map(job => (
              <JobCard key={job.job_key} job={job} now={now} dispatch={dispatches.get(job.dispatch_id)} runs={history.get(job.job_key) ?? []}
                retry={{ blockedBy: retryBlockedBy }} />
            ))}
          </Section>

          {summary.retrying.length > 0 ? (
            <Section title="Retrying" empty="">
              {summary.retrying.map(job => (
                <JobCard key={job.job_key} job={job} now={now} dispatch={dispatches.get(job.dispatch_id)} runs={history.get(job.job_key) ?? []} />
              ))}
            </Section>
          ) : null}

          {summary.inProgress.length > 0 ? (
            <Section title="Queued and running" empty="">
              {summary.inProgress.map(job => (
                <JobCard key={job.job_key} job={job} now={now} dispatch={dispatches.get(job.dispatch_id)} runs={history.get(job.job_key) ?? []} compact />
              ))}
            </Section>
          ) : null}
        </>
      )}
    </div>
  );
}

function Section({ title, empty, children }: { title: string; empty: string; children: React.ReactNode[] }) {
  return (
    <section className="space-y-3" aria-label={title}>
      <h2 className="text-lg font-semibold">{title}</h2>
      {children.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500">{empty}</div>
      ) : children}
    </section>
  );
}

function JobCard({ job, now, dispatch, runs, compact = false, retry }: {
  job: JobRow; now: Date; dispatch: DispatchInfo | undefined; runs: JobRunRow[]; compact?: boolean;
  retry?: { blockedBy: string | null };
}) {
  const advice = adviceFor(job.last_error);
  return (
    <article className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-5" data-testid="job" aria-label={`${kindLabel(job.kind)} ${dispatch?.orderName ?? job.dispatch_id}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-semibold">{kindLabel(job.kind)}</span>
            <Badge tone={STATE_TONE[job.state]}>{job.state === 'failed' ? 'retrying' : job.state}</Badge>
          </div>
          <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {dispatch?.orderName ? <>Order {dispatch.orderName} · </> : null}
            Dispatch <span className="font-mono text-xs">{dispatch?.sourceDispatchKey ?? job.dispatch_id}</span>
            {dispatch && dispatch.trackingNumbers.length > 0 ? (
              <> · Tracking <span className="font-mono text-xs">{dispatch.trackingNumbers.join(', ')}</span></>
            ) : null}
          </div>
        </div>
        <div className="text-right text-xs text-zinc-500 whitespace-nowrap">
          <div>{job.attempts === 0 ? 'Not tried yet' : <>Attempt {job.attempts} of {MAX_ATTEMPTS}</>}</div>
          <div className="mt-0.5">updated {relativeTime(job.updated_at)}</div>
        </div>
      </div>

      {job.last_error && !compact ? (
        <div className="mt-3 space-y-1 text-sm">
          <div className="font-mono text-xs text-red-700 dark:text-red-300 break-words">{job.last_error}</div>
          {advice ? <div className="text-zinc-700 dark:text-zinc-300">{advice}</div> : null}
        </div>
      ) : null}
      <div className="mt-2 text-sm text-zinc-600 dark:text-zinc-400">{nextStep(job, now)}</div>

      {retry ? (
        retry.blockedBy ? (
          <div className="mt-3 text-sm text-zinc-500" data-testid="retry-unavailable">{retry.blockedBy}</div>
        ) : (
          <form method="post" action="/jobs/retry" className="mt-3 flex flex-wrap items-center gap-2">
            <input type="hidden" name="job_key" value={job.job_key} />
            <input type="hidden" name="expected_updated_at" value={job.updated_at} />
            <label className="sr-only" htmlFor={`reason-${job.job_key}`}>Reason for retrying</label>
            <input id={`reason-${job.job_key}`} name="reason" required minLength={3} maxLength={500}
              placeholder="What did you fix? (recorded with the retry)"
              className="flex-1 min-w-[16rem] rounded border border-zinc-300 dark:border-zinc-700 bg-white dark:bg-zinc-900 px-3 py-1.5 text-sm" />
            <button type="submit" className="rounded border border-zinc-400 dark:border-zinc-600 px-3 py-1.5 text-sm font-medium hover:bg-zinc-100 dark:hover:bg-zinc-800">
              Retry now
            </button>
          </form>
        )
      ) : null}

      {runs.length > 0 && !compact ? (
        <details className="mt-3">
          <summary className="text-xs font-semibold text-zinc-500 uppercase tracking-wide cursor-pointer">
            Attempt history ({runs.length})
          </summary>
          <ol className="mt-2 space-y-1 text-xs">
            {runs.map((run, i) => (
              <li key={i} className="flex gap-3">
                <span className="tabular-nums text-zinc-500 whitespace-nowrap">{formatDateTime(run.finished_at)}</span>
                <span className="whitespace-nowrap">{run.outcome === 'operator_retry' ? 'retried by operator' : <>#{run.attempt} {run.outcome}</>}</span>
                <span className="font-mono text-zinc-600 dark:text-zinc-400 break-words">
                  {run.outcome === 'operator_retry'
                    ? `${String(run.detail?.actor_email ?? '')}: ${String(run.detail?.reason ?? '')}`
                    : typeof run.detail?.error === 'string' ? run.detail.error : ''}
                </span>
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </article>
  );
}
