// Console membership management (0049): the fixed outcome map. The database owns the
// rules (grant, pause, identity, email validity, first-member and self-disable lockout
// guards, stale edits and retry stability); this module only maps its refusals to fixed
// operator-facing outcomes — raw errors never reach the browser.

export const MEMBER_OUTCOMES = {
  member_saved: { ok: true, text: 'Membership saved. A disabled member loses access on their very next request.' },
  invalid: { ok: false, text: 'Check the email address. Nothing was saved.' },
  exists: { ok: false, text: 'That email is already a member. Enable or disable the existing row instead; nothing was saved.' },
  changed: { ok: false, text: 'This member changed after the page loaded, so nothing was saved. Check the list again below.' },
  self_disable: { ok: false, text: 'You cannot disable your own membership — another operator must. Nothing was saved.' },
  first_self: { ok: false, text: 'The first member must be yourself: adding someone else first would cut off every operator who is not yet a member. Nothing was saved.' },
  email_fixed: { ok: false, text: 'A member’s email is fixed. Add a new member and disable the old one; nothing was saved.' },
  not_allowed: { ok: false, text: 'Managing members is switched off for this business (its operator grant is missing, revoked, or set to require approval); a business turns it on deliberately. Nothing was saved.' },
  paused: { ok: false, text: 'Business actions are paused, so nothing was saved. Resume them first.' },
  not_found: { ok: false, text: 'That member no longer exists for this business. Nothing was saved.' },
  failed: { ok: false, text: 'The membership change could not be saved. Nothing changed; try again.' },
} as const;
export type MemberOutcome = keyof typeof MEMBER_OUTCOMES;

const SAVE_ERRORS: Array<[RegExp, MemberOutcome]> = [
  [/business actions paused/, 'paused'],
  [/tool entitlement missing or revoked|must not require approval|agent disabled/, 'not_allowed'],
  [/valid member email is required/, 'invalid'],
  [/member already exists/, 'exists'],
  [/add your own membership first/, 'first_self'],
  [/member email is fixed/, 'email_fixed'],
  [/changed since it was loaded/, 'changed'],
  [/you cannot disable your own membership/, 'self_disable'],
  [/member not found/, 'not_found'],
];
export function memberOutcomeFor(errorMessage: string): MemberOutcome {
  return SAVE_ERRORS.find(([pattern]) => pattern.test(errorMessage))?.[1] ?? 'failed';
}
export function isMemberOutcome(value: unknown): value is MemberOutcome {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(MEMBER_OUTCOMES, value);
}
