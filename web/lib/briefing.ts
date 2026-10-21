// Daily briefing view model (AI-01, migration 0038). Pure functions, no IO. The briefing
// is narration over the deterministic dashboard; when it is missing, stale or was rejected
// by the grounding check, the console says so plainly — the dashboard above it is always
// the source of truth.

export interface BriefingRef { kind: 'approval' | 'job' | 'invoice'; id: string; label: string }

export interface BriefingRow {
  generated_at: string;
  narration: string | null;
  refs: BriefingRef[];
  status: 'ok' | 'rejected';
  model: string;
}

/** A briefing older than this is no longer the day's briefing. */
export const BRIEFING_FRESH_MS = 26 * 60 * 60_000;

export type BriefingView =
  | { state: 'fresh'; narration: string; generatedAt: string; refs: BriefingRef[] }
  | { state: 'absent' };

export function briefingView(row: BriefingRow | null, now: Date): BriefingView {
  if (!row || row.status !== 'ok' || !row.narration) return { state: 'absent' };
  if (now.getTime() - new Date(row.generated_at).getTime() > BRIEFING_FRESH_MS) return { state: 'absent' };
  return { state: 'fresh', narration: row.narration, generatedAt: row.generated_at, refs: Array.isArray(row.refs) ? row.refs : [] };
}

/** Where a cited record lives in the console. */
export function refHref(ref: BriefingRef): string {
  switch (ref.kind) {
    case 'approval': return '/approvals';
    case 'job': return '/jobs';
    case 'invoice': return `/invoices/${ref.id}`;
  }
}
