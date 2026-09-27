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
  const { data: dispatch, error } = await sb.from('dispatches').select('*')
    .eq('org_id', context.orgId).eq('source_id', context.sourceId).eq('id', dispatchId).maybeSingle();
  if (error) throw error;
  if (!dispatch) return null;
  const { data: lines, error: lineError } = await sb.from('dispatch_lines').select('*')
    .eq('org_id', context.orgId).eq('source_id', context.sourceId).eq('dispatch_id', dispatchId)
    .eq('active', true).order('source_line_key');
  if (lineError) throw lineError;
  return { ...dispatch, lines: lines ?? [] };
}
