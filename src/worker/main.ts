// Atlas worker — the second process in the Fly app (PR-O). Runs the recovery loops that
// must not depend on anyone hitting an HTTP endpoint: outbox drain (with lease reaping)
// and projection replay. PR-R extends this into the full scheduler (Shopify sync,
// approval-expiry sweep, dashboard rollup) with recorded job runs; the process shape —
// boot, tick loop, clean SIGTERM — is what deployment needs pinned down now.
//
// Ticks never overlap: the loop awaits each tick, then sleeps. A tick failure is logged
// and the loop continues — the work is idempotent (outbox leases + projection state),
// so the next tick picks up where the failed one stopped.

import 'dotenv/config';
import { log } from '../platform/log.js';
import { bootPlatform } from '../platform/orchestration/boot.js';
import { drain as drainOutbox } from '../platform/tools/outbox.js';
import { replay } from '../platform/events/projector.js';

const INTERVAL_MS = Number(process.env.WORKER_INTERVAL_MS ?? 60_000);

let stopping = false;
let wake: (() => void) | null = null;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      wake = null;
      resolve();
    }, ms);
    wake = () => {
      clearTimeout(t);
      wake = null;
      resolve();
    };
  });
}

function shutdown(signal: string): void {
  log.info('worker.shutdown_requested', { signal });
  stopping = true;
  wake?.();                 // cut the sleep short; the current tick finishes first
}

async function tick(): Promise<void> {
  try {
    const drained = await drainOutbox();
    const replayed = await replay();
    log.info('worker.tick', {
      outbox_processed: drained,
      replay_scanned: replayed.scanned,
      replay_projected: replayed.projected,
      replay_failed: replayed.failed,
      replay_dead: replayed.dead,
    });
  } catch (e) {
    log.error('worker.tick_failed', { error: (e as Error).message });
  }
}

async function main(): Promise<void> {
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await bootPlatform();
  log.info('worker.started', { interval_ms: INTERVAL_MS });

  while (!stopping) {
    await tick();
    if (stopping) break;
    await sleep(INTERVAL_MS);
  }

  log.info('worker.stopped');
}

main().catch((e) => {
  log.error('worker.fatal', { error: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});
