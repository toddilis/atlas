// Approvals queue — read-only list of pending approvals. The policy engine writes a
// row here whenever invokeTool returns 'escalate'. Operators triage by reading the
// payload + reasons; approve/deny actions arrive in a later PR alongside auth.

import { supabaseServer, orgId } from '@/lib/supabase';

// Server-side rendered with no client-side hydration of the query result. Re-fetch by
// reloading the page. Auto-refresh / polling arrives in the realtime PR.
export const dynamic = 'force-dynamic';

interface ApprovalRow {
  id: string;
  agent_name: string;
  action: string;
  subject_type: string;
  subject_id: string | null;
  payload: Record<string, unknown>;
  proposed_summary: string | null;
  risk: string;
  created_at: string;
  expires_at: string | null;
}

async function loadPendingApprovals(): Promise<ApprovalRow[]> {
  const sb = supabaseServer();
  const { data, error } = await sb
    .from('approvals')
    .select(
      'id, agent_name, action, subject_type, subject_id, payload, proposed_summary, risk, created_at, expires_at',
    )
    .eq('org_id', orgId())
    .eq('state', 'pending')
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data as ApprovalRow[]) ?? [];
}

function relativeTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

export default async function ApprovalsPage() {
  const rows = await loadPendingApprovals();

  return (
    <div className="space-y-6">
      <div className="flex items-baseline justify-between">
        <h1 className="text-2xl font-semibold">Pending approvals</h1>
        <div className="text-sm text-zinc-500">
          {rows.length} {rows.length === 1 ? 'item' : 'items'}
        </div>
      </div>

      {rows.length === 0 ? (
        <div className="rounded-lg border border-dashed border-zinc-300 dark:border-zinc-700 p-10 text-center text-zinc-500">
          No pending approvals. Anything an agent escalated will show up here.
        </div>
      ) : (
        <div className="space-y-3">
          {rows.map((row) => (
            <ApprovalCard key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
}

function ApprovalCard({ row }: { row: ApprovalRow }) {
  const reasons = extractReasons(row.payload);
  return (
    <div className="rounded-lg border border-zinc-200 dark:border-zinc-800 p-5">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 text-sm">
            <span className="font-mono font-semibold">{row.action}</span>
            <span className="text-zinc-500">·</span>
            <span className="text-zinc-600 dark:text-zinc-400">{row.agent_name}</span>
            <RiskBadge risk={row.risk} />
          </div>
          <div className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
            {row.subject_type}
            {row.subject_id ? (
              <>
                {' · '}
                <span className="font-mono text-xs">{row.subject_id}</span>
              </>
            ) : null}
          </div>
        </div>
        <div className="text-right text-xs text-zinc-500 whitespace-nowrap">
          <div>{relativeTime(row.created_at)}</div>
          {row.expires_at ? (
            <div className="mt-0.5">expires {relativeTime(row.expires_at)}</div>
          ) : null}
        </div>
      </div>

      {row.proposed_summary ? (
        <div className="mt-3 text-sm text-zinc-700 dark:text-zinc-300">
          {row.proposed_summary}
        </div>
      ) : null}

      {reasons.length > 0 ? (
        <div className="mt-3">
          <div className="text-xs font-semibold text-zinc-500 uppercase tracking-wide">
            Policy reasons
          </div>
          <ul className="mt-1 space-y-0.5 text-sm">
            {reasons.map((r, i) => (
              <li key={i} className="font-mono text-xs text-zinc-700 dark:text-zinc-300">
                {r}
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <details className="mt-3">
        <summary className="text-xs font-semibold text-zinc-500 uppercase tracking-wide cursor-pointer">
          Payload
        </summary>
        <pre className="mt-2 text-xs bg-zinc-50 dark:bg-zinc-900 p-3 rounded overflow-x-auto">
          {JSON.stringify(row.payload, null, 2)}
        </pre>
      </details>
    </div>
  );
}

function RiskBadge({ risk }: { risk: string }) {
  const color =
    risk === 'approve_required'
      ? 'bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-200'
      : risk === 'notify'
        ? 'bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-200'
        : 'bg-zinc-100 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200';
  return (
    <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${color}`}>{risk}</span>
  );
}

/**
 * The policy engine stores the decision (with reasons) inside the approval payload
 * under `decision.reasons`. Pull them out so the operator sees why this escalated
 * without expanding the raw JSON.
 */
function extractReasons(payload: Record<string, unknown>): string[] {
  const decision = payload['decision'] as { reasons?: unknown } | undefined;
  if (!decision || !Array.isArray(decision.reasons)) return [];
  return (decision.reasons as unknown[]).filter((r): r is string => typeof r === 'string');
}
