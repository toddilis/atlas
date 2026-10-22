// Console business controls (0041): the emergency stop's fixed outcome map. The
// database owns the rules (grant, identity, reason, durable upsert, audit); this module
// only maps its refusals to fixed operator-facing outcomes — raw errors never reach the
// browser.

export interface PauseState {
  paused: boolean;
  changedBy: string | null;
  reason: string | null;
  changedAt: string | null;
  can: boolean;
}

export const CONTROLS_OUTCOMES = {
  paused_now: { ok: true, text: 'Business actions are paused. Nothing is claimed or executed until they are resumed.' },
  resumed_now: { ok: true, text: 'Business actions are resumed. Claims and executions continue from here.' },
  reason: { ok: false, text: 'Give a short reason (at least 3 characters). Nothing changed.' },
  not_allowed: { ok: false, text: 'The emergency stop is switched off for this business (its operator grant is missing, revoked, or set to require approval). Nothing changed.' },
  failed: { ok: false, text: 'The change could not be recorded. Nothing changed; try again.' },
} as const;
export type ControlsOutcome = keyof typeof CONTROLS_OUTCOMES;

const PAUSE_ERRORS: Array<[RegExp, ControlsOutcome]> = [
  [/tool entitlement missing or revoked|must not require approval|agent disabled/, 'not_allowed'],
  [/pause reason required/, 'reason'],
];
export function controlsOutcomeFor(errorMessage: string): ControlsOutcome {
  return PAUSE_ERRORS.find(([pattern]) => pattern.test(errorMessage))?.[1] ?? 'failed';
}
export function isControlsOutcome(value: unknown): value is ControlsOutcome {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONTROLS_OUTCOMES, value);
}
