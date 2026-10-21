// Today view model for the console home (TODAY-01). Pure functions, no IO and no model:
// the page loads rows, this decides what the operator's day looks like. Everything here
// must stay accurate when every model is unavailable, because nothing here uses one.

import type { JobRow } from './jobs';

export interface TodayInvoiceRow {
  id: string;
  state: string;
  currency: string;
  total_cents: number;
  due_at: string | null;
  issued_at: string | null;
  created_at: string;
  /** Present when BILL drafted this invoice as a dispatch part (0028). */
  snapshot: { id: string } | Array<{ id: string }> | null;
}

export interface SyncSourceRow {
  id: string;
  connection_key: string;
  enabled: boolean;
  sync_every_minutes: number;
}

export interface TodayRunRow {
  job_key: string;
  outcome: string;
  finished_at: string;
}

export const DAY_MS = 24 * 60 * 60_000;

const hasSnapshot = (row: TodayInvoiceRow) => Array.isArray(row.snapshot) ? row.snapshot.length > 0 : row.snapshot != null;

/** Drafted parts an operator can approve and issue now (the 4b journey). */
export const draftParts = (invoices: TodayInvoiceRow[]) => invoices.filter(i => i.state === 'draft' && hasSnapshot(i));

/** Money a retailer still owes: issued or partially paid, grouped by currency. Overdue is
 * calendar-honest only to the stored due timestamp; the ledger owns the aging buckets. */
export function receivables(invoices: TodayInvoiceRow[], now: Date) {
  const open = invoices.filter(i => i.state === 'issued' || i.state === 'partial');
  const byCurrency = new Map<string, { count: number; totalCents: number; overdueCount: number; overdueCents: number }>();
  for (const invoice of open) {
    const entry = byCurrency.get(invoice.currency) ?? { count: 0, totalCents: 0, overdueCount: 0, overdueCents: 0 };
    entry.count += 1;
    entry.totalCents += invoice.total_cents;
    if (invoice.due_at != null && new Date(invoice.due_at).getTime() < now.getTime()) {
      entry.overdueCount += 1;
      entry.overdueCents += invoice.total_cents;
    }
    byCurrency.set(invoice.currency, entry);
  }
  return [...byCurrency.entries()].map(([currency, totals]) => ({ currency, ...totals }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}

export type Freshness =
  | { state: 'never' }
  | { state: 'fresh'; lastAt: string }
  | { state: 'stale'; lastAt: string; overdueMs: number };

/** A connection is stale once three cadences (at least 30 minutes) pass without a
 * successful sync — late enough to mean something is wrong, not one slow run. */
export function sourceFreshness(source: SyncSourceRow, lastSuccessAt: string | null, now: Date): Freshness {
  if (!lastSuccessAt) return { state: 'never' };
  const allowance = Math.max(3 * source.sync_every_minutes * 60_000, 30 * 60_000);
  const age = now.getTime() - new Date(lastSuccessAt).getTime();
  return age > allowance ? { state: 'stale', lastAt: lastSuccessAt, overdueMs: age - allowance } : { state: 'fresh', lastAt: lastSuccessAt };
}

/** Latest successful run per job key, from newest-first or unsorted runs. */
export function lastSuccessByJob(runs: TodayRunRow[]): Map<string, string> {
  const byJob = new Map<string, string>();
  for (const run of runs) {
    if (run.outcome !== 'succeeded') continue;
    const existing = byJob.get(run.job_key);
    if (!existing || run.finished_at > existing) byJob.set(run.job_key, run.finished_at);
  }
  return byJob;
}

export const withinLastDay = (iso: string | null, now: Date) =>
  iso != null && now.getTime() - new Date(iso).getTime() <= DAY_MS && new Date(iso).getTime() <= now.getTime();

/** Jobs the worker should pick up now, and the stopped ones a person owns. */
export function jobAttention(jobs: JobRow[], now: Date) {
  const due = jobs.filter(j => ['pending', 'failed', 'blocked'].includes(j.state) && new Date(j.next_attempt_at).getTime() <= now.getTime());
  return {
    blocked: jobs.filter(j => j.state === 'blocked').length,
    quarantined: jobs.filter(j => j.state === 'quarantined').length,
    retrying: jobs.filter(j => j.state === 'failed').length,
    running: jobs.filter(j => j.state === 'running').length,
    dueNow: due.length,
  };
}

/** The next moment a sync job will run, if any is armed. */
export function nextSyncAt(jobs: JobRow[]): string | null {
  const armed = jobs.filter(j => j.kind === 'shopify_sync' && ['pending', 'failed', 'blocked'].includes(j.state))
    .map(j => j.next_attempt_at).sort();
  return armed[0] ?? null;
}

/** Pending approvals that die within a day unless someone decides them. */
export const expiringSoon = (expiresAt: Array<string | null>, now: Date) =>
  expiresAt.filter(at => at != null && new Date(at).getTime() > now.getTime()
    && new Date(at).getTime() - now.getTime() <= DAY_MS).length;
