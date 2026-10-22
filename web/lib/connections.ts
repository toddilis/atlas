// Console Shopify connection (0042): the fixed outcome map. The database owns the
// rules (grant, pause, canonical domain, one connection per business, fixed key,
// cadence bounds, stale edits, audit); this module only maps its refusals to fixed
// operator-facing outcomes — raw errors never reach the browser.

export interface ConnectionRow {
  id: string; connection_key: string; enabled: boolean; sync_every_minutes: number; updated_at: string;
}

export const CONNECTION_OUTCOMES = {
  connection_saved: { ok: true, text: 'Connection saved. The scheduled sync follows it from the next worker pass.' },
  bad_domain: { ok: false, text: 'Enter the canonical shop domain, like your-shop.myshopify.com. Nothing changed.' },
  already_connected: { ok: false, text: 'This business already has its Shopify connection (one per business). Edit it below instead. Nothing changed.' },
  key_fixed: { ok: false, text: 'The shop domain is the connection’s identity and cannot change. A different shop is a new connection. Nothing changed.' },
  cadence: { ok: false, text: 'The sync cadence must be between 1 and 1440 minutes. Nothing changed.' },
  stale: { ok: false, text: 'The connection changed since the page was loaded. Nothing changed; reload and edit the current version.' },
  not_allowed: { ok: false, text: 'Connection editing is switched off for this business (its operator grant is missing or revoked). Nothing changed.' },
  paused: { ok: false, text: 'Business actions are paused, so nothing changed. Resume them first.' },
  not_found: { ok: false, text: 'That connection no longer exists for this business. Nothing changed.' },
  failed: { ok: false, text: 'The change could not be saved. Nothing changed; try again.' },
} as const;
export type ConnectionOutcome = keyof typeof CONNECTION_OUTCOMES;

const SAVE_ERRORS: Array<[RegExp, ConnectionOutcome]> = [
  [/business actions paused/, 'paused'],
  [/tool entitlement missing or revoked|must not require approval|agent disabled/, 'not_allowed'],
  [/canonical Shopify shop domain/, 'bad_domain'],
  [/already has its Shopify connection|binding mismatch/, 'already_connected'],
  [/shop domain is fixed/, 'key_fixed'],
  [/sync cadence minutes out of range/, 'cadence'],
  [/changed since it was loaded/, 'stale'],
  [/connection fields required|operator identity required/, 'failed'],
  [/not found/i, 'not_found'],
];
export function connectionOutcomeFor(errorMessage: string): ConnectionOutcome {
  return SAVE_ERRORS.find(([pattern]) => pattern.test(errorMessage))?.[1] ?? 'failed';
}
export function isConnectionOutcome(value: unknown): value is ConnectionOutcome {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(CONNECTION_OUTCOMES, value);
}
