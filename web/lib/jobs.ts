// Background job view model for the console (JOBS-01, migration 0029). Pure functions,
// no IO: the page loads rows, this decides what an operator needs to see and do.

export type JobState = 'pending' | 'running' | 'succeeded' | 'failed' | 'blocked' | 'quarantined';

export interface JobRow {
  job_key: string;
  kind: string;
  state: JobState;
  attempts: number;
  next_attempt_at: string;
  lease_until: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
  dispatch_id: string;
}

export interface JobRunRow {
  job_key: string;
  attempt: number;
  outcome: string;
  finished_at: string;
  detail: Record<string, unknown>;
}

/** finish_scheduled_job quarantines a job once this many attempts have run. */
export const MAX_ATTEMPTS = 8;
/** The worker ticks every minute; a due job left this long means it is not running. */
export const STALE_AFTER_MS = 10 * 60_000;

export const KIND_LABELS: Record<string, string> = { carrier_cost_sync: 'Carrier cost sync' };
export const kindLabel = (kind: string) => KIND_LABELS[kind] ?? kind;

const ADVICE: Array<[RegExp, string]> = [
  [/^GOSWEETSPOT_/, 'Set this GoSweetSpot setting on the worker host. The job tries again on its next attempt.'],
  [/HTTP 40[13]/, 'GoSweetSpot refused the request. Check GOSWEETSPOT_ACCESS_KEY and GOSWEETSPOT_SITE_ID on the worker host.'],
  [/unexpected shipments response shape/, 'GoSweetSpot replied in a format Atlas does not read, so no cost was recorded. The adapter needs a developer.'],
  [/does not cover every tracking number/, 'GoSweetSpot has no consignment for one of this dispatch\'s Shopify tracking numbers. Check the shipment was booked in GoSweetSpot under that tracking number.'],
  [/no tracking number|no Shopify fulfillment/, 'The Shopify fulfillment has no tracking number. Add it in Shopify; the next sync picks it up.'],
  [/two decimals|outside supported range/, 'GoSweetSpot reported a cost Atlas will not round. The adapter needs a developer.'],
  [/replay conflicts/, 'GoSweetSpot now reports a different cost for consignments already recorded. Atlas kept the recorded cost; check the shipment in GoSweetSpot.'],
  [/lease expired/, 'The worker stopped during this run. It is retried automatically.'],
];
export function adviceFor(error: string | null): string | null {
  if (!error) return null;
  return ADVICE.find(([pattern]) => pattern.test(error))?.[1] ?? null;
}

function duration(ms: number): string {
  const m = Math.round(Math.abs(ms) / 60_000);
  if (m < 1) return 'under a minute';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return m % 60 && h < 6 ? `${h} h ${m % 60} min` : `${h} h`;
  return `${Math.floor(h / 24)} days`;
}

/** What happens next for one job, in words. */
export function nextStep(job: JobRow, now: Date): string {
  const at = new Date(job.next_attempt_at).getTime() - now.getTime();
  switch (job.state) {
    case 'quarantined':
      return `Stopped after ${job.attempts} attempts. Atlas will not retry it on its own.`;
    case 'running':
      return job.lease_until && new Date(job.lease_until).getTime() <= now.getTime()
        ? 'The worker stopped during this run. The next worker pass records it and retries.'
        : 'Running now.';
    case 'succeeded':
      return 'Done.';
    default:
      if (at <= 0) return `Due now (attempt ${job.attempts + 1} of ${MAX_ATTEMPTS}).`;
      return `Next attempt in ${duration(at)} (attempt ${job.attempts + 1} of ${MAX_ATTEMPTS}).`;
  }
}

export interface JobsSummary {
  counts: Record<JobState, number>;
  needsAttention: JobRow[];
  retrying: JobRow[];
  inProgress: JobRow[];
  /** Jobs that should have been picked up by now but were not. */
  overdue: JobRow[];
  lastRunAt: string | null;
}

export function summarize(jobs: JobRow[], runs: JobRunRow[], now: Date): JobsSummary {
  const counts: Record<JobState, number> = { pending: 0, running: 0, succeeded: 0, failed: 0, blocked: 0, quarantined: 0 };
  for (const job of jobs) counts[job.state] = (counts[job.state] ?? 0) + 1;
  const newest = (a: JobRow, b: JobRow) => b.updated_at.localeCompare(a.updated_at);
  const cutoff = now.getTime() - STALE_AFTER_MS;
  return {
    counts,
    // Quarantined first: nothing will happen to them without a person.
    needsAttention: [
      ...jobs.filter(j => j.state === 'quarantined').sort(newest),
      ...jobs.filter(j => j.state === 'blocked').sort(newest),
    ],
    retrying: jobs.filter(j => j.state === 'failed').sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at)),
    inProgress: jobs.filter(j => j.state === 'pending' || j.state === 'running').sort((a, b) => a.next_attempt_at.localeCompare(b.next_attempt_at)),
    overdue: jobs.filter(j =>
      (['pending', 'failed', 'blocked'].includes(j.state) && new Date(j.next_attempt_at).getTime() < cutoff)
      || (j.state === 'running' && j.lease_until != null && new Date(j.lease_until).getTime() < cutoff)),
    lastRunAt: runs.reduce<string | null>((latest, r) => (!latest || r.finished_at > latest ? r.finished_at : latest), null),
  };
}

/** Most recent runs first, per job. */
export function runsByJob(runs: JobRunRow[]): Map<string, JobRunRow[]> {
  const byJob = new Map<string, JobRunRow[]>();
  for (const run of [...runs].sort((a, b) => b.finished_at.localeCompare(a.finished_at))) {
    const list = byJob.get(run.job_key) ?? [];
    list.push(run);
    byJob.set(run.job_key, list);
  }
  return byJob;
}

/** Outcome codes of the console's retry action, carried in the redirect back to /jobs.
 * Only these fixed messages are shown; nothing from the URL is echoed. */
export const RETRY_OUTCOMES = {
  retried: { ok: true, text: 'Job queued. The worker picks it up on its next pass, within about a minute.' },
  paused: { ok: false, text: 'Business actions are paused, so nothing was retried. Resume them first.' },
  not_allowed: { ok: false, text: 'Retrying jobs is switched off for this business (the operator jobs.retry grant is missing or revoked). Nothing was retried.' },
  changed: { ok: false, text: 'This job changed after the page loaded. Nothing was retried; check its current state below.' },
  not_stopped: { ok: false, text: 'This job is no longer blocked or stopped, so there was nothing to retry.' },
  not_needed: { ok: false, text: 'This dispatch no longer needs a carrier cost (it has one, or its order is invoiced). Nothing was retried.' },
  reason: { ok: false, text: 'Give a short reason for the retry (at least 3 characters). Nothing was retried.' },
  not_found: { ok: false, text: 'That job no longer exists. Nothing was retried.' },
  failed: { ok: false, text: 'The retry could not be recorded. Nothing changed; try again.' },
} as const;
export type RetryOutcome = keyof typeof RETRY_OUTCOMES;

const RETRY_ERRORS: Array<[RegExp, RetryOutcome]> = [
  [/business actions paused/, 'paused'],
  [/tool entitlement missing or revoked|agent disabled/, 'not_allowed'],
  [/job changed since it was loaded/, 'changed'],
  [/only blocked or quarantined/, 'not_stopped'],
  [/job no longer needed/, 'not_needed'],
  [/retry reason required/, 'reason'],
  [/job not found/, 'not_found'],
];
export function retryOutcomeFor(errorMessage: string): RetryOutcome {
  return RETRY_ERRORS.find(([pattern]) => pattern.test(errorMessage))?.[1] ?? 'failed';
}
export function isRetryOutcome(value: unknown): value is RetryOutcome {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(RETRY_OUTCOMES, value);
}
