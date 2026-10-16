import { AsyncLocalStorage } from 'node:async_hooks';

const context = new AsyncLocalStorage<{ replay: boolean }>();

/** Explicit projection rebuilds cannot dispatch agents or business tools. */
export function withProjectionReplay<T>(fn: () => T): T {
  return context.run({ replay: true }, fn);
}
export function isProjectionReplay(): boolean { return context.getStore()?.replay === true; }
export function assertEffectsAllowed(): void {
  if (isProjectionReplay()) throw new Error('Business effects are forbidden during projection replay');
}
