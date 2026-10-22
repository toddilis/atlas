// Console business profile (0045): the fixed outcome map. The database owns the rules
// (grant, pause, identity, bounds, stale edits, retry stability, audit); this module
// only maps its refusals to fixed operator-facing outcomes.

export interface ProfileRow {
  legal_name: string | null; tax_label: string; tax_number: string | null;
  address: string | null; payment_instructions: string | null; updated_at: string;
}

export const PROFILE_OUTCOMES = {
  profile_saved: { ok: true, text: 'Business profile saved. Printed invoices carry it from the next print.' },
  stale: { ok: false, text: 'The profile changed since the page was loaded. Nothing changed; reload and edit the current version.' },
  invalid: { ok: false, text: 'Check the fields: they are over their length limits. Nothing changed.' },
  not_allowed: { ok: false, text: 'Profile editing is switched off for this business (its operator grant is missing or revoked). Nothing changed.' },
  paused: { ok: false, text: 'Business actions are paused, so nothing changed. Resume them first.' },
  failed: { ok: false, text: 'The profile could not be saved. Nothing changed; try again.' },
} as const;
export type ProfileOutcome = keyof typeof PROFILE_OUTCOMES;

const SAVE_ERRORS: Array<[RegExp, ProfileOutcome]> = [
  [/business actions paused/, 'paused'],
  [/tool entitlement missing or revoked|must not require approval|agent disabled/, 'not_allowed'],
  [/changed since it was loaded/, 'stale'],
  [/profile field too long|operator identity required/, 'invalid'],
];
export function profileOutcomeFor(errorMessage: string): ProfileOutcome {
  return SAVE_ERRORS.find(([pattern]) => pattern.test(errorMessage))?.[1] ?? 'failed';
}
export function isProfileOutcome(value: unknown): value is ProfileOutcome {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(PROFILE_OUTCOMES, value);
}
