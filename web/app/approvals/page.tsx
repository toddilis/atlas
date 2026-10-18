// Approvals — pending proposals an operator decides here (0037), and recent decisions
// with what execution did. The policy engine writes a pending row whenever a tool
// invocation escalates; approving AUTHORISES the stored action and the worker executes
// it (approved_action_execute); rejecting is final. The database enforces pause, grants,
// expiry and policy; this page only shows state and collects the decision.

import { supabaseServer, orgId } from '@/lib/supabase';
import {
  APPROVAL_OUTCOMES, executionStatus, extractReasons, isApprovalOutcome, isExpired, lastErrorByAction,
  type ApprovalListRow, type AttemptRow, type BoundActionRow,
} from '@/lib/approvals';

// Server-side rendered with no client-side hydration of the query result. Re-fetch by
// reloading the page.
export const dynamic = 'force-dynamic';

interface Actions { decide: boolean; note: string | null }

async function loadApprovals() {
  const sb = await supabaseServer();
  const org = orgId();
  const select = 'id, agent_name, action, subject_type, subject_id, payload, proposed_summary, risk, state, decided_by, decided_at, reason, created_at, expires_at';
  const [pending, decided, grants, controls] = await Promise.all([
    sb.from('approvals').select(select).eq('org_id', org).eq('state', 'pending').order('created_at', { ascending: false }).limit(200),
    sb.from('approvals').select(select).eq('org_id', org).neq('state', 'pending').order('decided_at', { ascending: false }).limit(20),
    sb.from('tool_grants').select('tool_name, enabled').eq('org_id', org).eq('agent_name', 'operator').eq('tool_name', 'approvals.decide'),
    sb.from('action_controls').select('paused').eq('org_id', org).maybeSingle(),
  ]);
  for (const r of [pending, decided, grants, controls]) if (r.error) throw r.error;
  const rows = [...((pending.data ?? []) as ApprovalListRow[]), ...((decided.data ?? []) as ApprovalListRow[])];
  const actionsById = new Map<string, BoundActionRow>();
  const lastErrors = new Map<string, string | null>();
  if (rows.length) {
    const { data: bound, error } = await sb.from('approved_actions').select('approval_id, id, state, revoked_at, updated_at')
      .eq('org_id', org).in('approval_id', rows.map(r => r.id));
    if (error) throw error;
    for (const action of (bound ?? []) as BoundActionRow[]) actionsById.set(action.approval_id, action);
    const actionIds = [...actionsById.values()].map(a => a.id);
    if (actionIds.length) {
      const { data: attempts, error: attemptError } = await sb.from('action_attempts')
        .select('action_id, attempt_number, state, error, finished_at').eq('org_id', org).in('action_id', actionIds);
      if (attemptError) throw attemptError;
      for (const [actionId, message] of lastErrorByAction((attempts ?? []) as AttemptRow[])) lastErrors.set(actionId, message);
    }
  }
  // Shown so the operator knows before trying; the database enforces pause and the grant
  // on every decision.
  const paused = Boolean(controls.data?.paused);
  const granted = (grants.data ?? []).some(g => g.enabled);
  const actions: Actions = {
    decide: !paused && granted,
    note: paused ? 'Business actions are paused, so approvals cannot be decided until they are resumed.'
      : !granted ? 'Deciding approvals is switched off for this business (the operator approvals.decide grant is missing or revoked).' : null,
  };
  return {
    pending: (pending.data ?? []) as ApprovalListRow[],
    decided: (decided.data ?? []) as ApprovalListRow[],
    actionsById, lastErrors, actions,
  };
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(Math.abs(ms) / 1000);
  const suffix = ms >= 0 ? 'ago' : 'from now';
  if (s < 60) return `${s}s ${suffix}`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${suffix}`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${suffix}`;
  return `${Math.floor(h / 24)}d ${suffix}`;
}

export default async function ApprovalsPage({ searchParams }: { searchParams: Promise<{ outcome?: string }> }) {
  const now = new Date();
  const { outcome } = await searchParams;
  const notice = isApprovalOutcome(outcome) ? APPROVAL_OUTCOMES[outcome] : null;
  const { pending, decided, actionsById, lastErrors, actions } = await loadApprovals();

  return (
    <div className="space-y-8">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Approvals</h1>
        <div className="text-sm text-zinc-500">
          {pending.length} pending
        </div>
      </div>

      {notice ? (
        <div data-testid="approval-notice" role="status" className={`rounded-lg border p-4 text-sm ${notice.ok
          ? 'border-green-300 bg-green-50 text-green-900 dark:border-green-800 dark:bg-green-950/40 dark:text-green-200'
          : 'border-red-300 bg-red-50 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-200'}`}>
          {notice.text}
        </div>
      ) : null}

      {actions.note ? (
        <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-4 text-sm text-zinc-600 dark:text-zinc-400">{actions.note}</div>
      ) : null}

      <section className="space-y-3" aria-label="Pending approvals">
        <h2 className="text-lg font-semibold">Pending</h2>
        {pending.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center text-zinc-500">
            No pending approvals. Anything an agent escalates waits here for a decision.
          </div>
        ) : (
          pending.map(row => (
            <ApprovalCard key={row.id} row={row} now={now}
              action={actionsById.get(row.id)} lastErrors={lastErrors} decide={actions.decide} />
          ))
        )}
      </section>

      <section className="space-y-3" aria-label="Recently decided">
        <h2 className="text-lg font-semibold">Recently decided</h2>
        {decided.length === 0 ? (
          <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-6 text-center text-sm text-zinc-500">
            Nothing decided yet.
          </div>
        ) : (
          decided.map(row => (
            <ApprovalCard key={row.id} row={row} now={now}
              action={actionsById.get(row.id)} lastErrors={lastErrors} decide={false} />
          ))
        )}
      </section>
    </div>
  );
}

function ApprovalCard({ row, now, action, lastErrors, decide }: {
  row: ApprovalListRow; now: Date; action: BoundActionRow | undefined;
  lastErrors: Map<string, string | null>; decide: boolean;
}) {
  const reasons = extractReasons(row.payload);
  const bound = action !== undefined;
  const expired = isExpired(row, now);
  const execution = executionStatus(row, action, action ? (lastErrors.get(action.id) ?? null) : null, now);
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-5" data-testid="approval">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-mono font-semibold">{row.action}</span>
            <span className="text-zinc-500">·</span>
            <span className="text-zinc-600 dark:text-zinc-400">{row.agent_name}</span>
            <StateBadge state={row.state} expired={expired} />
          </div>
          <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {row.subject_type}
            {row.subject_id ? <>{' · '}<span className="font-mono text-xs">{row.subject_id}</span></> : null}
          </div>
        </div>
        <div className="text-right text-xs text-zinc-500 whitespace-nowrap">
          <div>proposed {relativeTime(row.created_at)}</div>
          {row.state === 'pending' && row.expires_at ? (
            <div className="mt-0.5">{expired ? 'expired' : 'expires'} {relativeTime(row.expires_at)}</div>
          ) : null}
        </div>
      </div>

      {row.proposed_summary ? (
        <div className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">{row.proposed_summary}</div>
      ) : null}

      {reasons.length > 0 ? (
        <div className="mt-3">
          <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">Policy reasons</div>
          <ul className="mt-1 space-y-0.5 text-sm">
            {reasons.map((r, i) => (
              <li key={i} className="font-mono text-xs text-zinc-700 dark:text-zinc-300">{r}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {row.state !== 'pending' ? (
        <div className="mt-3 text-sm text-zinc-600 dark:text-zinc-400">
          {row.state === 'approved' ? 'Approved' : 'Rejected'} by {row.decided_by ?? 'unknown'}
          {row.decided_at ? <> {relativeTime(row.decided_at)}</> : null}
          {row.reason ? <> — “{row.reason}”</> : null}
        </div>
      ) : null}

      {execution ? (
        <div className="mt-2 text-sm text-zinc-700 dark:text-zinc-300" data-testid="execution-status">{execution}</div>
      ) : null}

      {row.state === 'pending' && !bound ? (
        <div className="mt-3 text-sm text-amber-700 dark:text-amber-300">
          Proposed before approvals were bound to stored actions, so it cannot be decided here. The agent must propose it again.
        </div>
      ) : null}

      {row.state === 'pending' && bound && decide && !expired ? (
        <form method="post" action="/approvals/decide" className="mt-4 flex flex-wrap items-end gap-2">
          <input type="hidden" name="approval_id" value={row.id} />
          <label className="flex-1 min-w-56 text-sm">
            <span className="block text-xs font-semibold text-zinc-500 uppercase tracking-wide">Reason</span>
            <input name="reason" required minLength={3} maxLength={500} placeholder="Why this decision"
              className="mt-1 w-full rounded border border-zinc-300 dark:border-zinc-700 bg-transparent px-2 py-1.5 text-sm" />
          </label>
          <button type="submit" name="disposition" value="approved"
            className="rounded bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-3 py-1.5 text-sm font-medium">
            Approve
          </button>
          <button type="submit" name="disposition" value="rejected"
            className="rounded border border-zinc-300 dark:border-zinc-700 px-3 py-1.5 text-sm font-medium">
            Reject
          </button>
        </form>
      ) : null}

      <details className="mt-3">
        <summary className="text-xs font-semibold text-zinc-500 uppercase tracking-wide cursor-pointer">Payload</summary>
        <pre className="mt-2 text-xs bg-zinc-50 dark:bg-zinc-900 p-3 rounded overflow-x-auto">
          {JSON.stringify(row.payload, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function StateBadge({ state, expired }: { state: ApprovalListRow['state']; expired: boolean }) {
  const label = state === 'pending' && expired ? 'expired' : state;
  const color =
    label === 'pending'
      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
      : label === 'approved'
        ? 'bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-200'
        : label === 'rejected'
          ? 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200'
          : 'bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-200';
  return <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${color}`}>{label}</span>;
}
