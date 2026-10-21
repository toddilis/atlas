// The assistant's whitelisted query tools (AI-01, PR-T). Read-only by contract: each tool
// is one bounded, org-scoped select over read-models, and each run is recorded as a
// citation by code — the model cannot invent what was queried. No write tool exists here,
// and none may be added without the §10 contract changing.

import 'server-only';
import { supabaseServer, orgId } from './supabase';

export interface Citation { tool: string; args: Record<string, unknown>; rows: Array<{ kind: 'invoice' | 'job' | 'approval'; id: string; label: string }> }
export interface ToolRun { citation: Citation; result: unknown }

const LIMIT = 20;
const clampLimit = (value: unknown) => Math.min(Math.max(Number.isInteger(value) ? (value as number) : LIMIT, 1), LIMIT);

export const ASSISTANT_TOOL_DEFS = [
  {
    name: 'invoices_lookup',
    description: 'Look up this business\'s invoices. Filter by state (draft/issued/partial/paid/void), overdue_only, or an exact invoice_number.',
    input_schema: {
      type: 'object' as const, additionalProperties: false,
      properties: {
        state: { type: 'string', enum: ['draft', 'issued', 'partial', 'paid', 'void'] },
        overdue_only: { type: 'boolean' }, invoice_number: { type: 'string' },
        limit: { type: 'integer', minimum: 1, maximum: LIMIT },
      },
    },
  },
  {
    name: 'jobs_lookup',
    description: 'Look up background jobs. Filter by state (pending/running/succeeded/failed/blocked/quarantined/dismissed) or kind.',
    input_schema: {
      type: 'object' as const, additionalProperties: false,
      properties: {
        state: { type: 'string', enum: ['pending', 'running', 'succeeded', 'failed', 'blocked', 'quarantined', 'dismissed'] },
        kind: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: LIMIT },
      },
    },
  },
  {
    name: 'approvals_lookup',
    description: 'Look up approvals. Filter by state (pending/approved/rejected).',
    input_schema: {
      type: 'object' as const, additionalProperties: false,
      properties: {
        state: { type: 'string', enum: ['pending', 'approved', 'rejected'] },
        limit: { type: 'integer', minimum: 1, maximum: LIMIT },
      },
    },
  },
];

export type ToolExecutor = (name: string, args: Record<string, unknown>) => Promise<ToolRun>;

/** Runs one whitelisted tool against the business's own rows. Unknown tools are refused. */
export const executeAssistantTool: ToolExecutor = async (name, args) => {
  const sb = await supabaseServer();
  const org = orgId();
  const limit = clampLimit(args['limit']);
  if (name === 'invoices_lookup') {
    let query = sb.from('invoices').select('id, invoice_number, state, currency, total_cents, due_at, issued_at')
      .eq('org_id', org).order('created_at', { ascending: false }).limit(limit);
    if (typeof args['state'] === 'string') query = query.eq('state', args['state']);
    if (typeof args['invoice_number'] === 'string') query = query.eq('invoice_number', args['invoice_number']);
    if (args['overdue_only'] === true) query = query.in('state', ['issued', 'partial']).lt('due_at', new Date().toISOString());
    const { data, error } = await query;
    if (error) throw error;
    const rows = (data ?? []).map(r => ({ ...r, total: `${(r.total_cents / 100).toFixed(2)} ${r.currency}` }));
    return { citation: { tool: name, args, rows: rows.map(r => ({ kind: 'invoice' as const, id: r.id, label: `invoice ${r.invoice_number} (${r.state})` })) }, result: rows };
  }
  if (name === 'jobs_lookup') {
    let query = sb.from('scheduled_jobs').select('job_key, kind, state, attempts, last_error, next_attempt_at, updated_at')
      .eq('org_id', org).order('updated_at', { ascending: false }).limit(limit);
    if (typeof args['state'] === 'string') query = query.eq('state', args['state']);
    if (typeof args['kind'] === 'string') query = query.eq('kind', args['kind']);
    const { data, error } = await query;
    if (error) throw error;
    return { citation: { tool: name, args, rows: (data ?? []).map(r => ({ kind: 'job' as const, id: r.job_key, label: `${r.state} ${r.kind} job` })) }, result: data ?? [] };
  }
  if (name === 'approvals_lookup') {
    let query = sb.from('approvals').select('id, action, agent_name, state, proposed_summary, decided_by, decided_at, expires_at, created_at')
      .eq('org_id', org).order('created_at', { ascending: false }).limit(limit);
    if (typeof args['state'] === 'string') query = query.eq('state', args['state']);
    const { data, error } = await query;
    if (error) throw error;
    return { citation: { tool: name, args, rows: (data ?? []).map(r => ({ kind: 'approval' as const, id: r.id, label: `${r.state} approval: ${r.action}` })) }, result: data ?? [] };
  }
  throw new Error(`assistant tool ${name} is not whitelisted`);
};
