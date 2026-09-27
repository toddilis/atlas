import { supabase } from '../../data/supabase.js';

/** Internal service context, supplied by an authenticated connection/job owner. */
export interface DispatchContext { orgId: string; sourceId: string }

/**
 * Provider-neutral read contract. State/revision must be rechecked by claim_dispatch
 * INSIDE the future BILL-01 invoice transaction; this read does not reserve quantities.
 * This is not a public authorization boundary and must not take context from a browser.
 */
export async function readDispatch(context: DispatchContext, dispatchId: string) {
  const sb = supabase();
  // One database statement gives header and lines the same revision snapshot. The
  // composite FK scopes the embedded lines to this header's business and source.
  const { data: dispatch, error } = await sb.from('dispatches').select('*, lines:dispatch_lines(*)')
    .eq('org_id', context.orgId).eq('source_id', context.sourceId).eq('id', dispatchId)
    .eq('lines.active', true).order('source_line_key', { referencedTable: 'lines' }).maybeSingle();
  if (error) throw error;
  return dispatch;
}
