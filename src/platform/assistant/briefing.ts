import { supabase } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';
import { anthropic, model } from '../../integrations/anthropic/client.js';
import { assertNumbersGrounded } from './grounding.js';

// AI-01: the daily briefing narrates the deterministic rollup (PLAN PR-S). Deterministic
// code computes every figure and picks every record reference; the model only turns those
// facts into sentences. The grounding check below rejects any narration that introduces a
// number or a record the snapshot does not contain, so a hallucinated figure can never be
// stored as the day's briefing.

export interface BriefingRef { kind: 'approval' | 'job' | 'invoice'; id: string; label: string }

export interface BriefingSnapshot {
  businessId: string;
  generatedAt: string;
  facts: {
    paused: boolean;
    pendingApprovals: number;
    approvalsExpiringWithinDay: number;
    blockedJobs: number;
    quarantinedJobs: number;
    draftPartsAwaitingIssue: number;
    uncertainExecutions: number;
    outstanding: Array<{ currency: string; count: number; total: string }>;
    overdue: Array<{ currency: string; count: number; total: string }>;
    connections: Array<{ connection: string; lastSuccessfulSyncAt: string | null }>;
    last24h: { partsDrafted: number; invoicesIssued: number; syncsSucceeded: number; costsRecorded: number; approvalsDecided: number };
  };
  refs: BriefingRef[];
}

/** The deterministic facts, from stored rows alone. Money is formatted here (integer
 * cents owned by the database); the narrator receives finished strings. */
export async function buildBriefingSnapshot(orgId: string, now = new Date()): Promise<BriefingSnapshot> {
  const sb = supabase();
  const cutoff = new Date(now.getTime() - 24 * 60 * 60_000).toISOString();
  const [approvals, jobs, drafts, uncertain, open, sources, syncRuns, recentRuns, partsDrafted, issued, costs, decided, controls] = await Promise.all([
    sb.from('approvals').select('id, action, expires_at').eq('org_id', orgId).eq('state', 'pending').order('created_at', { ascending: false }).limit(200),
    sb.from('scheduled_jobs').select('job_key, kind, state, last_error').eq('org_id', orgId).in('state', ['blocked', 'quarantined']).order('updated_at', { ascending: false }).limit(200),
    sb.from('invoices').select('id, invoice_number, snapshot:invoice_calculation_snapshots!inner(id)').eq('org_id', orgId).eq('state', 'draft').limit(100),
    sb.from('approved_actions').select('id', { count: 'exact', head: true }).eq('org_id', orgId).in('state', ['UNRESOLVED', 'RECONCILIATION_REQUIRED']),
    sb.from('invoices').select('id, invoice_number, currency, total_cents, due_at').eq('org_id', orgId).in('state', ['issued', 'partial']).limit(1000),
    sb.from('dispatch_sources').select('id, connection_key').eq('org_id', orgId).eq('provider', 'shopify').eq('enabled', true),
    sb.from('job_runs').select('job_key, finished_at').eq('org_id', orgId).like('job_key', 'shopify-sync:%').eq('outcome', 'succeeded').order('finished_at', { ascending: false }).limit(50),
    sb.from('job_runs').select('job_key', { count: 'exact', head: true }).eq('org_id', orgId).like('job_key', 'shopify-sync:%').eq('outcome', 'succeeded').gte('finished_at', cutoff),
    sb.from('invoice_calculation_snapshots').select('id', { count: 'exact', head: true }).eq('org_id', orgId).gte('created_at', cutoff),
    sb.from('invoices').select('id', { count: 'exact', head: true }).eq('org_id', orgId).gte('issued_at', cutoff),
    sb.from('carrier_cost_evidence').select('id', { count: 'exact', head: true }).eq('org_id', orgId).gte('recorded_at', cutoff),
    sb.from('approvals').select('id', { count: 'exact', head: true }).eq('org_id', orgId).gte('decided_at', cutoff),
    sb.from('action_controls').select('paused').eq('org_id', orgId).maybeSingle(),
  ]);
  for (const r of [approvals, jobs, drafts, uncertain, open, sources, syncRuns, recentRuns, partsDrafted, issued, costs, decided, controls]) if (r.error) throw r.error;

  const money = new Map<string, { count: number; total: number; overdueCount: number; overdueTotal: number }>();
  for (const invoice of open.data ?? []) {
    const entry = money.get(invoice.currency) ?? { count: 0, total: 0, overdueCount: 0, overdueTotal: 0 };
    entry.count += 1; entry.total += invoice.total_cents;
    if (invoice.due_at != null && new Date(invoice.due_at).getTime() < now.getTime()) { entry.overdueCount += 1; entry.overdueTotal += invoice.total_cents; }
    money.set(invoice.currency, entry);
  }
  const amount = (cents: number, currency: string) => `${(cents / 100).toFixed(2)} ${currency}`;
  const lastSync = new Map<string, string>();
  for (const run of syncRuns.data ?? []) if (!lastSync.has(run.job_key)) lastSync.set(run.job_key, run.finished_at);
  const overdueInvoices = (open.data ?? []).filter(i => i.due_at != null && new Date(i.due_at).getTime() < now.getTime());

  const refs: BriefingRef[] = [
    ...(approvals.data ?? []).slice(0, 3).map(a => ({ kind: 'approval' as const, id: a.id, label: `pending approval: ${a.action}` })),
    ...(jobs.data ?? []).slice(0, 3).map(j => ({ kind: 'job' as const, id: j.job_key, label: `${j.state} job: ${j.last_error ?? j.kind}`.slice(0, 120) })),
    ...overdueInvoices.slice(0, 3).map(i => ({ kind: 'invoice' as const, id: i.id, label: `overdue invoice ${i.invoice_number}` })),
  ];

  return {
    businessId: orgId,
    generatedAt: now.toISOString(),
    facts: {
      paused: Boolean(controls.data?.paused),
      pendingApprovals: (approvals.data ?? []).length,
      approvalsExpiringWithinDay: (approvals.data ?? []).filter(a => a.expires_at != null
        && new Date(a.expires_at).getTime() > now.getTime()
        && new Date(a.expires_at).getTime() - now.getTime() <= 24 * 60 * 60_000).length,
      blockedJobs: (jobs.data ?? []).filter(j => j.state === 'blocked').length,
      quarantinedJobs: (jobs.data ?? []).filter(j => j.state === 'quarantined').length,
      draftPartsAwaitingIssue: (drafts.data ?? []).length,
      uncertainExecutions: uncertain.count ?? 0,
      outstanding: [...money.entries()].map(([currency, m]) => ({ currency, count: m.count, total: amount(m.total, currency) })),
      overdue: [...money.entries()].filter(([, m]) => m.overdueCount > 0)
        .map(([currency, m]) => ({ currency, count: m.overdueCount, total: amount(m.overdueTotal, currency) })),
      connections: (sources.data ?? []).map(s => ({ connection: s.connection_key, lastSuccessfulSyncAt: lastSync.get(`shopify-sync:${s.id}`) ?? null })),
      last24h: {
        partsDrafted: partsDrafted.count ?? 0, invoicesIssued: issued.count ?? 0,
        syncsSucceeded: recentRuns.count ?? 0, costsRecorded: costs.count ?? 0, approvalsDecided: decided.count ?? 0,
      },
    },
    refs,
  };
}

/** Reject a narration that introduces any number or record the snapshot does not carry.
 * Every digit run in the narration must appear as a digit run somewhere in the facts
 * (dates in generatedAt/refs excluded on purpose: the narration may not use them either). */
export function assertGrounded(snapshot: BriefingSnapshot, narration: string, refIds: string[]): void {
  if (!narration.trim() || narration.length > 700) throw new Error('briefing rejected: narration empty or too long');
  assertNumbersGrounded(JSON.stringify(snapshot.facts), narration, 'briefing');
  const known = new Set(snapshot.refs.map(r => r.id));
  for (const id of refIds) {
    if (!known.has(id)) throw new Error(`briefing rejected: narration cites unknown record ${id}`);
  }
}

const SYSTEM = `You write the operator's daily briefing for a small business, from a JSON snapshot of deterministic facts.
Rules, all hard:
- Two to four plain sentences. Describe what needs the operator and what happened; no advice beyond what the facts state.
- Use only numbers that appear in the facts, written exactly as they appear. Never add, convert, total or recompute anything.
- You may cite records only from the snapshot's refs list, by copying their ids into refIds.
- If the facts are quiet, say so plainly.
Answer with JSON only, no other text: {"narration": string, "refIds": string[]}`;

export type Narrator = (snapshot: BriefingSnapshot) => Promise<{ narration: string; refIds: string[]; model: string }>;

/** One Claude call over the snapshot. Figures and refs are validated by assertGrounded at
 * the call site; this only produces candidates. */
export const narrateWithClaude: Narrator = async (snapshot) => {
  const response = await anthropic().messages.create({
    model: model(),
    max_tokens: 1024,
    system: SYSTEM,
    messages: [{ role: 'user', content: JSON.stringify({ facts: snapshot.facts, refs: snapshot.refs }) }],
  });
  if (response.stop_reason !== 'end_turn') throw new Error(`briefing rejected: narration stopped early (${response.stop_reason})`);
  const text = response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
  return { ...parseNarration(text), model: response.model };
};

/** The agreed output contract, enforced; anything else is a rejected narration. */
export function parseNarration(text: string): { narration: string; refIds: string[] } {
  let parsed: { narration?: unknown; refIds?: unknown };
  try { parsed = JSON.parse(text) as { narration?: unknown; refIds?: unknown }; }
  catch { throw new Error('briefing rejected: narration was not the agreed JSON'); }
  if (typeof parsed.narration !== 'string' || !Array.isArray(parsed.refIds) || parsed.refIds.some(r => typeof r !== 'string')) {
    throw new Error('briefing rejected: narration was not the agreed JSON');
  }
  return { narration: parsed.narration, refIds: parsed.refIds as string[] };
}

export interface BriefingRecord { status: 'ok' | 'rejected'; briefingId: string; model: string; error?: string }

export type BriefingRecorder = (args: { orgId: string; model: string; snapshot: BriefingSnapshot; narration: string | null; refs: BriefingRef[]; status: 'ok' | 'rejected'; error: string | null }) => Promise<string>;

const recordWithDatabase: BriefingRecorder = async (args) => {
  // p_narration/p_error are nullable text in SQL; the generated types flatten that away.
  const { data, error } = await supabase().rpc('record_daily_briefing', {
    p_org_id: args.orgId, p_model: args.model, p_snapshot: args.snapshot as unknown as Json,
    p_narration: args.narration as unknown as string, p_refs: args.refs as unknown as Json,
    p_status: args.status, p_error: args.error as unknown as string,
  });
  if (error) throw error;
  return data as string;
};

/** Build, narrate, ground and store one briefing. A rejected narration is stored with its
 * reason — never shown as the day's briefing, never silently retried here. */
export async function generateDailyBriefing(orgId: string,
  options: { narrate?: Narrator; load?: (orgId: string, now: Date) => Promise<BriefingSnapshot>; record?: BriefingRecorder; now?: Date } = {}): Promise<BriefingRecord> {
  const narrate = options.narrate ?? narrateWithClaude;
  const record = options.record ?? recordWithDatabase;
  const snapshot = await (options.load ?? buildBriefingSnapshot)(orgId, options.now ?? new Date());
  const candidate = await narrate(snapshot);
  const refs = snapshot.refs.filter(r => candidate.refIds.includes(r.id));
  let failure: string | null = null;
  try { assertGrounded(snapshot, candidate.narration, candidate.refIds); }
  catch (error) { failure = error instanceof Error ? error.message : String(error); }
  const briefingId = await record({ orgId, model: candidate.model, snapshot,
    narration: failure ? null : candidate.narration, refs, status: failure ? 'rejected' : 'ok', error: failure });
  if (failure) throw new Error(failure);
  return { status: 'ok', briefingId, model: candidate.model };
}
