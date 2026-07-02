import { timingSafeEqual } from 'node:crypto';

export type BearerAuthState = 'ok' | 'unauthorized' | 'unconfigured';

/**
 * Check a raw Authorization header against the configured API token. Pure — the caller
 * supplies both sides. Fails closed: no configured token means nothing authenticates
 * (the route answers 503 so a misconfigured deploy is loud, not open).
 */
export function bearerAuthState(
  authorizationHeader: string | undefined,
  configuredToken: string | undefined,
): BearerAuthState {
  if (!configuredToken) return 'unconfigured';
  if (!authorizationHeader || !authorizationHeader.startsWith('Bearer ')) {
    return 'unauthorized';
  }
  const presented = Buffer.from(authorizationHeader.slice('Bearer '.length));
  const expected = Buffer.from(configuredToken);
  if (presented.length !== expected.length) return 'unauthorized';
  return timingSafeEqual(presented, expected) ? 'ok' : 'unauthorized';
}
