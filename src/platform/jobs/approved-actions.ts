import { supabase } from '../../data/supabase.js';
import { executeApproved } from '../tools/registry.js';
import { messageOf, runJobPass, scheduledJobs, type JobsStore } from './store.js';

// JOBS-01 runner for approved bound actions (0037). An operator's console approval puts
// the action in AUTHORISED; this loop claims the job and runs the stored intent through
// executeApproved, which re-checks the agent's grant, the policy snapshot and the material
// subject before atomically claiming a durable attempt (0022). The attempt record, not
// this job, is the evidence of what happened; the job adds discovery, backoff and the
// console's visibility. Refusals that need a person (changed policy or subject, an
// uncertain earlier attempt) are blocked with their reason; outages retry.

export type { JobsStore } from './store.js';
export type ApprovedExecutor = (context: { orgId: string; actionId: string }) => Promise<Record<string, unknown>>;

const NEEDS_A_PERSON = [/policy changed/, /material subject changed|subject changed/, /approval not valid|not pending or has expired|revoked/,
  /already claimed or unresolved|reconcile first/, /unknown stored tool/, /lacks material-state contract/,
  /policy configured but stored tool has no extractor/, /current policy blocks action/,
  /tool entitlement missing or revoked|agent disabled/, /execution unresolved/];
export function classifyApprovedAction(error: unknown): 'retry' | 'blocked' {
  const message = messageOf(error);
  return NEEDS_A_PERSON.some(p => p.test(message)) ? 'blocked' : 'retry';
}

/** Execute one stored action. The intent, its business and every amount come from the
 * stored rows; the worker contributes only its own executor identity. An execution whose
 * confirmation evidence is missing is UNRESOLVED on the action and blocks the job: it is
 * never silently retried (the next claim of the action would refuse anyway). */
export async function executeStoredAction(context: { orgId: string; actionId: string }): Promise<Record<string, unknown>> {
  const { data, error } = await supabase().from('approved_actions').select('approval_id')
    .eq('org_id', context.orgId).eq('id', context.actionId).single();
  if (error) throw error;
  const outcome = await executeApproved(data.approval_id, { companyId: context.orgId, actorId: 'worker:approved-actions' });
  if (outcome.status !== 'CONFIRMED') throw new Error(`execution unresolved: no confirmation evidence for action ${context.actionId}`);
  return { approval_id: data.approval_id, action_id: outcome.actionId, execution_id: outcome.executionId, status: outcome.status };
}

export const approvedActionJobs: JobsStore = scheduledJobs('approved_action_execute');

/** One scheduler pass for a business: discover approved-but-unexecuted actions, then run
 * up to `limit`. */
export async function runApprovedActionJobs(orgId: string, options: { limit?: number; store?: JobsStore; execute?: ApprovedExecutor } = {}) {
  const execute = options.execute ?? executeStoredAction;
  return runJobPass(orgId, options.store ?? approvedActionJobs, async job => {
    // The executor job always names its action (scheduled_jobs_action_scope, 0037).
    return execute({ orgId, actionId: job.action_id! });
  }, classifyApprovedAction, options.limit ?? 5);
}
