// Console home — the operator's day (TODAY-01). Everything on this page is counted from
// stored rows: what needs a person, what the worker is doing, what happened in the last
// 24 hours, what retailers still owe and how fresh each source is. No model is involved,
// so it stays accurate when every model is unavailable.

import Link from 'next/link';
import { supabaseServer, orgId } from '@/lib/supabase';
import { formatCents } from '@/lib/format';
import type { JobRow } from '@/lib/jobs';
import {
  DAY_MS, draftParts, expiringSoon, jobAttention, lastSuccessByJob, nextSyncAt, receivables, sourceFreshness, withinLastDay,
  type SyncSourceRow, type TodayInvoiceRow, type TodayRunRow,
} from '@/lib/today';

export const dynamic = 'force-dynamic';

async function loadToday(now: Date) {
  const sb = await supabaseServer();
  const org = orgId();
  const cutoff = new Date(now.getTime() - DAY_MS).toISOString();
  const [pendingApprovals, decidedRecently, uncertain, jobs, syncRuns, recentRuns, sources, openInvoices, draftInvoices,
    partsDrafted, issuedRecently, lastCost, costsRecently, controls] = await Promise.all([
    sb.from('approvals').select('id, expires_at').eq('org_id', org).eq('state', 'pending').limit(500),
    sb.from('approvals').select('id', { count: 'exact', head: true }).eq('org_id', org).gte('decided_at', cutoff),
    sb.from('approved_actions').select('id', { count: 'exact', head: true }).eq('org_id', org).in('state', ['UNRESOLVED', 'RECONCILIATION_REQUIRED']),
    sb.from('scheduled_jobs').select('job_key, kind, state, attempts, next_attempt_at, lease_until, last_error, created_at, updated_at, dispatch_id')
      .eq('org_id', org).neq('state', 'succeeded').limit(500),
    sb.from('job_runs').select('job_key, outcome, finished_at').eq('org_id', org)
      .like('job_key', 'shopify-sync:%').eq('outcome', 'succeeded').order('finished_at', { ascending: false }).limit(50),
    sb.from('job_runs').select('job_key, outcome, finished_at').eq('org_id', org).gte('finished_at', cutoff).limit(500),
    sb.from('dispatch_sources').select('id, connection_key, enabled, sync_every_minutes').eq('org_id', org).eq('provider', 'shopify'),
    sb.from('invoices').select('id, state, currency, total_cents, due_at, issued_at, created_at')
      .eq('org_id', org).in('state', ['issued', 'partial']).limit(1000),
    sb.from('invoices').select('id, state, currency, total_cents, due_at, issued_at, created_at, snapshot:invoice_calculation_snapshots!inner(id)')
      .eq('org_id', org).eq('state', 'draft').limit(100),
    sb.from('invoice_calculation_snapshots').select('id', { count: 'exact', head: true }).eq('org_id', org).gte('created_at', cutoff),
    sb.from('invoices').select('id', { count: 'exact', head: true }).eq('org_id', org).gte('issued_at', cutoff),
    sb.from('carrier_cost_evidence').select('recorded_at').eq('org_id', org).order('recorded_at', { ascending: false }).limit(1),
    sb.from('carrier_cost_evidence').select('id', { count: 'exact', head: true }).eq('org_id', org).gte('recorded_at', cutoff),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
  ]);
  for (const r of [pendingApprovals, decidedRecently, uncertain, jobs, syncRuns, recentRuns, sources, openInvoices, draftInvoices,
    partsDrafted, issuedRecently, lastCost, costsRecently, controls]) if (r.error) throw r.error;

  const jobRows = (jobs.data ?? []) as JobRow[];
  const sourceRows = (sources.data ?? []) as SyncSourceRow[];
  const lastSyncSuccess = lastSuccessByJob((syncRuns.data ?? []) as TodayRunRow[]);
  const open = (openInvoices.data ?? []) as TodayInvoiceRow[];
  const drafts = (draftInvoices.data ?? []) as unknown as TodayInvoiceRow[];
  return {
    paused: Boolean(controls.data?.paused),
    pendingApprovals: (pendingApprovals.data ?? []).length,
    expiringApprovals: expiringSoon((pendingApprovals.data ?? []).map(a => a.expires_at as string | null), now),
    uncertainActions: uncertain.count ?? 0,
    jobs: jobAttention(jobRows, now),
    nextSync: nextSyncAt(jobRows),
    freshness: sourceRows.map(source => ({
      source,
      freshness: sourceFreshness(source, lastSyncSuccess.get(`shopify-sync:${source.id}`) ?? null, now),
    })),
    parts: draftParts(drafts),
    receivables: receivables(open, now),
    recent: {
      partsDrafted: partsDrafted.count ?? 0,
      invoicesIssued: issuedRecently.count ?? 0,
      syncsSucceeded: ((recentRuns.data ?? []) as TodayRunRow[])
        .filter(r => r.outcome === 'succeeded' && r.job_key.startsWith('shopify-sync:') && withinLastDay(r.finished_at, now)).length,
      costsRecorded: costsRecently.count ?? 0,
      approvalsDecided: decidedRecently.count ?? 0,
    },
    lastCostAt: ((lastCost.data ?? []) as Array<{ recorded_at: string }>)[0]?.recorded_at ?? null,
  };
}

function relative(iso: string, now: Date): string {
  const ms = new Date(iso).getTime() - now.getTime();
  const m = Math.round(Math.abs(ms) / 60_000);
  const span = m < 1 ? 'under a minute' : m < 60 ? `${m} min` : m < 48 * 60 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / (24 * 60))} days`;
  return ms >= 0 ? `in ${span}` : `${span} ago`;
}

export default async function HomePage() {
  const now = new Date();
  const today = await loadToday(now);
  const needsYou = today.pendingApprovals + today.jobs.blocked + today.jobs.quarantined + today.parts.length + today.uncertainActions;

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold">Atlas operator console</h1>
        <p className="mt-2 text-zinc-600 dark:text-zinc-400">Today, from the stored records alone.</p>
      </div>

      {today.paused ? (
        <div role="alert" className="rounded-lg border border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200 p-4 text-sm">
          Business actions are paused. Nothing is claimed or executed until they are resumed.
        </div>
      ) : null}

      <section className="space-y-3" aria-label="Needs you" data-testid="today-needs-you">
        <h2 className="text-lg font-semibold">Needs you</h2>
        {needsYou === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500">
            Nothing needs you right now.
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Stat testid="stat-approvals" href="/approvals" label="Pending approvals"
              value={String(today.pendingApprovals)}
              note={today.expiringApprovals > 0 ? `${today.expiringApprovals} expiring within a day` : null} />
            <Stat testid="stat-jobs" href="/jobs" label="Stopped jobs"
              value={`${today.jobs.blocked} blocked · ${today.jobs.quarantined} quarantined`} note={null} />
            <Stat testid="stat-parts" href="/invoices" label="Parts to approve and issue"
              value={String(today.parts.length)} note={null} />
            {today.uncertainActions > 0 ? (
              <Stat testid="stat-uncertain" href="/approvals" label="Uncertain executions"
                value={String(today.uncertainActions)} note="Needs reconciliation before anything else happens" />
            ) : null}
          </div>
        )}
      </section>

      <section className="space-y-3" aria-label="Running and upcoming">
        <h2 className="text-lg font-semibold">Running and upcoming</h2>
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-5 text-sm text-zinc-700 dark:text-zinc-300 space-y-1">
          <div>
            {today.jobs.running} running · {today.jobs.retrying} retrying · {today.jobs.dueNow} due now
          </div>
          <div data-testid="today-next-sync">
            {today.nextSync ? <>Next Shopify sync {relative(today.nextSync, now)}.</> : 'No Shopify sync armed.'}
          </div>
        </div>
      </section>

      <section className="space-y-3" aria-label="Source freshness" data-testid="today-freshness">
        <h2 className="text-lg font-semibold">Source freshness</h2>
        {today.freshness.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500">
            No Shopify connection bound yet.
          </div>
        ) : (
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-200 dark:divide-zinc-800">
            {today.freshness.map(({ source, freshness }) => (
              <div key={source.id} className="p-4 text-sm flex items-baseline justify-between gap-4">
                <span className="font-mono text-xs">{source.connection_key}{source.enabled ? '' : ' (disabled)'}</span>
                <span className={freshness.state === 'stale' ? 'text-red-700 dark:text-red-300 font-medium' : 'text-zinc-600 dark:text-zinc-400'}>
                  {freshness.state === 'never' ? 'No successful sync yet.'
                    : freshness.state === 'fresh' ? `Synced ${relative(freshness.lastAt, now)}.`
                      : `Stale — last successful sync ${relative(freshness.lastAt, now)} (every ${source.sync_every_minutes} min expected).`}
                </span>
              </div>
            ))}
          </div>
        )}
        {today.lastCostAt ? (
          <div className="text-xs text-zinc-500">Last carrier cost recorded {relative(today.lastCostAt, now)}.</div>
        ) : null}
      </section>

      <section className="space-y-3" aria-label="Receivables" data-testid="today-receivables">
        <h2 className="text-lg font-semibold">Receivables</h2>
        {today.receivables.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500">
            Nothing issued is outstanding.
          </div>
        ) : (
          <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 divide-y divide-zinc-200 dark:divide-zinc-800">
            {today.receivables.map(row => (
              <div key={row.currency} className="p-4 text-sm flex items-baseline justify-between gap-4">
                <span>
                  <Link href="/invoices" className="underline-offset-2 hover:underline">{row.count} outstanding</Link>
                  {' · '}{formatCents(row.totalCents, row.currency)}
                </span>
                <span className={row.overdueCount > 0 ? 'text-red-700 dark:text-red-300 font-medium' : 'text-zinc-500'}>
                  {row.overdueCount > 0 ? `${row.overdueCount} overdue · ${formatCents(row.overdueCents, row.currency)}` : 'None overdue'}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="space-y-3" aria-label="Last 24 hours">
        <h2 className="text-lg font-semibold">Last 24 hours</h2>
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-5 text-sm text-zinc-700 dark:text-zinc-300">
          {today.recent.partsDrafted} invoice {today.recent.partsDrafted === 1 ? 'part' : 'parts'} drafted ·{' '}
          {today.recent.invoicesIssued} issued · {today.recent.syncsSucceeded} Shopify {today.recent.syncsSucceeded === 1 ? 'sync' : 'syncs'} ·{' '}
          {today.recent.costsRecorded} carrier {today.recent.costsRecorded === 1 ? 'cost' : 'costs'} recorded ·{' '}
          {today.recent.approvalsDecided} {today.recent.approvalsDecided === 1 ? 'approval' : 'approvals'} decided
        </div>
      </section>
    </div>
  );
}

function Stat({ testid, href, label, value, note }: { testid: string; href: string; label: string; value: string; note: string | null }) {
  return (
    <Link href={href} data-testid={testid}
      className="block rounded-lg border border-zinc-200 dark:border-zinc-800 p-5 hover:border-zinc-400 dark:hover:border-zinc-600 transition">
      <div className="text-sm text-zinc-600 dark:text-zinc-400">{label}</div>
      <div className="mt-1 text-lg font-semibold">{value}</div>
      {note ? <div className="mt-1 text-xs text-amber-700 dark:text-amber-300">{note}</div> : null}
    </Link>
  );
}
