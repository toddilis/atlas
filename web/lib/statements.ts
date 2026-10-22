// Console statement generation (0044): the fixed outcome map. The database owns the
// rules (grant, pause, identity, as-of bounds, timezone validity, the derivation and
// retry stability); this module only maps its refusals to fixed operator-facing
// outcomes — raw errors never reach the browser.

export const STATEMENT_OUTCOMES = {
  statement_generated: { ok: true, text: 'Statement generated from the stored records; an identical request returns this same statement.' },
  invalid: { ok: false, text: 'Check the fields: a retailer, a period start on or before the as-of date, and an as-of date not in the future. Nothing was generated.' },
  not_allowed: { ok: false, text: 'Statement generation is switched off for this business (its operator grant is missing or revoked). Nothing was generated.' },
  paused: { ok: false, text: 'Business actions are paused, so nothing was generated. Resume them first.' },
  not_found: { ok: false, text: 'That retailer no longer exists for this business. Nothing was generated.' },
  failed: { ok: false, text: 'The statement could not be generated. Nothing changed; try again.' },
} as const;
export type StatementOutcome = keyof typeof STATEMENT_OUTCOMES;

const GENERATE_ERRORS: Array<[RegExp, StatementOutcome]> = [
  [/business actions paused/, 'paused'],
  [/tool entitlement missing or revoked|must not require approval|agent disabled/, 'not_allowed'],
  [/must not be in the future|invalid period/, 'invalid'],
  [/not found/i, 'not_found'],
];
export function statementOutcomeFor(errorMessage: string): StatementOutcome {
  return GENERATE_ERRORS.find(([pattern]) => pattern.test(errorMessage))?.[1] ?? 'failed';
}
export function isStatementOutcome(value: unknown): value is StatementOutcome {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(STATEMENT_OUTCOMES, value);
}
