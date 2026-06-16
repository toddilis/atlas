import { log } from '../log.js';
import type { AppendedEvent, EventType } from './types.js';

export type Projector = (event: AppendedEvent) => Promise<void>;

const registry: Map<EventType, Projector[]> = new Map();

export function registerProjector(type: EventType, fn: Projector): void {
  const existing = registry.get(type) ?? [];
  existing.push(fn);
  registry.set(type, existing);
}

export async function dispatch(event: AppendedEvent): Promise<void> {
  const projectors = registry.get(event.type) ?? [];
  for (const p of projectors) {
    try {
      await p(event);
    } catch (e) {
      log.error('projector.failed', {
        type: event.type,
        seq: event.seq,
        error: (e as Error).message,
      });
      throw e;
    }
  }
}

/**
 * Replay events from `fromSeq` (inclusive). Used to rebuild canonical read-models when a
 * projector changes or a bug needs fixing. Read-models must be safe to truncate + replay.
 */
export async function replay(_fromSeq: number): Promise<void> {
  // Implementation deferred — the spine + dispatch API is what Phase 0 commits to. Replay is a
  // straightforward `select * from event_log where seq >= $1 order by seq` + per-row dispatch,
  // but no projector in Phase 0 needs it yet.
  throw new Error('replay not implemented in Phase 0');
}
