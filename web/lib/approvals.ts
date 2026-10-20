// Approvals view model for the console (UI-01, migration 0037). Pure functions, no IO:
// the page loads rows, this decides what an operator needs to see and do.

export type ApprovalDisposition = 'pending' | 'approved' | 'rejected';
export type BoundActionState = 'PREPARED' | 'AUTHORISED' | 'EXECUTING' | 'CONFIRMED' | 'FAILED' | 'UNRESOLVED' | 'RECONCILIATION_REQUIRED';

export interface ApprovalListRow {
  id: string;
  agent_name: string;
  action: string;
  subject_type: string;
  subject_id: string | null;
  payload: Record<string, unknown>;
  proposed_summary: string | null;
  risk: string;
  state: ApprovalDisposition;
  decided_by: string | null;
  decided_at: string | null;
  reason: string | null;
  created_at: string;
  expires_at: string | null;
}

export interface BoundActionRow {
  approval_id: string;
  id: string;
  state: BoundActionState;
  revoked_at: string | null;
  updated_at: string;
}

export interface AttemptRow {
  action_id: string;
  attempt_number: number;
  state: string;
  error: string | null;
  finished_at: string | null;
}

export const isExpired = (approval: ApprovalListRow, now: Date) =>
  approval.expires_at != null && new Date(approval.expires_at).getTime() <= now.getTime();

/** What execution of a decided approval looks like from the operator's chair. */
export function executionStatus(approval: ApprovalListRow, action: BoundActionRow | undefined, lastError: string | null, now: Date): string | null {
  if (approval.state === 'rejected') return null;
  if (approval.state !== 'approved') return null;
  if (!action) return 'Prepared before approvals were bound to stored actions; it will not execute.';
  if (action.revoked_at) return 'Revoked after approval; it will not execute.';
  switch (action.state) {
    case 'AUTHORISED':
      return isExpired(approval, now)
        ? 'Approved, but the approval expired before the worker ran it. The agent must propose it again.'
        : 'Approved. The worker executes it on its next pass, within about a minute.';
    case 'EXECUTING':
      return 'Running now.';
    case 'CONFIRMED':
      return 'Executed and confirmed with evidence.';
    case 'FAILED':
      return lastError ? `Execution failed with no effect: ${lastError}` : 'Execution failed with no effect.';
    case 'UNRESOLVED':
    case 'RECONCILIATION_REQUIRED':
      return 'Execution result is uncertain; it needs reconciliation before anything else happens.';
    default:
      return null;
  }
}

/** Outcome codes of the console's decide action, carried in the redirect back to
 * /approvals. Only these fixed messages are shown; nothing from the URL is echoed. */
export const APPROVAL_OUTCOMES = {
  approved: { ok: true, text: 'Approved. The worker executes it on its next pass, within about a minute.' },
  rejected: { ok: true, text: 'Rejected. Nothing will be executed for this proposal.' },
  not_pending: { ok: false, text: 'This approval is no longer pending (it was decided, expired or revoked). Nothing changed; check its current state below.' },
  legacy: { ok: false, text: 'This approval predates bound actions and cannot be decided here. The agent must propose it again. Nothing changed.' },
  policy_changed: { ok: false, text: 'The policy for this action changed since it was proposed, so the proposal must be prepared again. Nothing changed.' },
  paused: { ok: false, text: 'Business actions are paused, so nothing changed. Resume them first.' },
  not_allowed: { ok: false, text: 'Deciding approvals is switched off for this business (its operator grant is missing or revoked). Nothing changed.' },
  agent_not_allowed: { ok: false, text: 'The proposing agent\'s own entitlement is missing or revoked, so this cannot be approved. Nothing changed.' },
  reason: { ok: false, text: 'Give a short reason (at least 3 characters). Nothing changed.' },
  not_found: { ok: false, text: 'That approval no longer exists. Nothing changed.' },
  failed: { ok: false, text: 'The decision could not be recorded. Nothing changed; try again.' },
} as const;
export type ApprovalOutcome = keyof typeof APPROVAL_OUTCOMES;

// assert_action_authority runs under the operator grant first, so pause and the
// operator's own grant map before the agent's entitlement is re-checked by the decision.
const DECIDE_ERRORS: Array<[RegExp, ApprovalOutcome]> = [
  [/business actions paused/, 'paused'],
  [/must not require approval/, 'not_allowed'],
  [/not pending or has expired\/revoked/, 'not_pending'],
  [/legacy\/unbound approval/, 'legacy'],
  [/policy changed/, 'policy_changed'],
  [/tool entitlement missing or revoked|agent disabled/, 'not_allowed'],
  [/decision reason required|invalid approval decision/, 'reason'],
  [/bound action not found|no rows/i, 'not_found'],
];
export function decideOutcomeFor(errorMessage: string): ApprovalOutcome {
  return DECIDE_ERRORS.find(([pattern]) => pattern.test(errorMessage))?.[1] ?? 'failed';
}
export function isApprovalOutcome(value: unknown): value is ApprovalOutcome {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(APPROVAL_OUTCOMES, value);
}

/**
 * The policy engine stores the decision (with reasons) inside the approval payload under
 * `decision.reasons`; bound intents (0022) carry none. Pull reasons out so the operator
 * sees why this escalated without expanding the raw JSON.
 */
export function extractReasons(payload: Record<string, unknown>): string[] {
  const decision = payload['decision'] as { reasons?: unknown } | undefined;
  if (!decision || !Array.isArray(decision.reasons)) return [];
  return (decision.reasons as unknown[]).filter((r): r is string => typeof r === 'string');
}

/** Most recent finished attempt error per action, for the failure explanation. */
export function lastErrorByAction(attempts: AttemptRow[]): Map<string, string | null> {
  const byAction = new Map<string, string | null>();
  for (const attempt of [...attempts].sort((a, b) => b.attempt_number - a.attempt_number)) {
    if (!byAction.has(attempt.action_id)) byAction.set(attempt.action_id, attempt.error ?? null);
  }
  return byAction;
}
