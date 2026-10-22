// Console statement actions (0044 generation, 0047 lifecycle): the fixed outcome maps.
// The database owns the rules (grant, pause, identity, bounds, transitions and retry
// stability); this module only maps its refusals to fixed operator-facing outcomes —
// raw errors never reach the browser.

export const STATEMENT_OUTCOMES = {
  statement_generated: { ok: true, text: 'Statement generated from the stored records; an identical request returns this same statement.' },
  statement_sent: { ok: true, text: 'Recorded as sent. The send itself was yours — Atlas only recorded the fact.' },
  statement_voided: { ok: true, text: 'Statement voided. Its figures stay on record; the statement must no longer be relied on.' },
  already_voided: { ok: false, text: 'This statement is already voided. Nothing changed.' },
  invalid: { ok: false, text: 'Check the fields: a retailer, a period start on or before the as-of date, and an as-of date not in the future. Nothing was generated.' },
  void_invalid: { ok: false, text: 'A void needs a reason (3–500 characters). Nothing changed.' },
  not_allowed: { ok: false, text: 'This statement action is switched off for this business (its operator grant is missing or revoked). Nothing changed.' },
  paused: { ok: false, text: 'Business actions are paused, so nothing changed. Resume them first.' },
  not_found: { ok: false, text: 'That statement or retailer no longer exists for this business. Nothing changed.' },
  failed: { ok: false, text: 'The statement action could not be completed. Nothing changed; try again.' },
} as const;
export type StatementOutcome = keyof typeof STATEMENT_OUTCOMES;

const SHARED_ERRORS: Array<[RegExp, StatementOutcome]> = [
  [/business actions paused/, 'paused'],
  [/tool entitlement missing or revoked|must not require approval|agent disabled/, 'not_allowed'],
  [/not found/i, 'not_found'],
];
const ACTION_ERRORS: Record<'generate' | 'send' | 'void', Array<[RegExp, StatementOutcome]>> = {
  generate: [[/must not be in the future|invalid period/, 'invalid']],
  send: [[/already voided/, 'already_voided']],
  void: [[/already voided/, 'already_voided'], [/void reason required|void reason too long/, 'void_invalid']],
};
export function statementOutcomeFor(action: 'generate' | 'send' | 'void', errorMessage: string): StatementOutcome {
  return [...ACTION_ERRORS[action], ...SHARED_ERRORS].find(([pattern]) => pattern.test(errorMessage))?.[1] ?? 'failed';
}
export function isStatementOutcome(value: unknown): value is StatementOutcome {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STATEMENT_OUTCOMES, value);
}
