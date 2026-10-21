// Atlas worker — the second process in the Fly app (PR-O). Runs everything that must not
// depend on anyone hitting an HTTP endpoint: outbox drain (with lease reaping), projection
// replay, and the JOBS-01 passes with recorded job runs — Shopify ingestion on each
// source's cadence (0036), carrier costs (0029) and invoice part drafts (0035). Remaining
// scheduler work (approval-expiry sweep, dashboard rollup) lands as further job kinds.
//
// Ticks never overlap: the loop awaits each tick, then sleeps. A tick failure is logged
// and the loop continues — the work is idempotent (outbox leases + projection state),
// so the next tick picks up where the failed one stopped.

import 'dotenv/config';
import { log } from '../platform/log.js';
import { bootPlatform } from '../platform/orchestration/boot.js';
import { drain as drainOutbox } from '../platform/tools/outbox.js';
import { replay } from '../platform/events/projector.js';
import { carrierCostSyncEnabled, runCarrierCostJobs } from '../platform/jobs/carrier-cost.js';
import { runShopifySyncJobs, shopifySyncEnabled } from '../platform/jobs/shopify-sync.js';
import { runApprovedActionJobs } from '../platform/jobs/approved-actions.js';
import { narrationEnabled, runDailyBriefingJobs } from '../platform/jobs/daily-briefing.js';
import { runInvoicePartJobs } from '../agents/controller/invoice-parts.js';
import { orgId } from '../data/supabase.js';

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
  // JOBS-01 scheduled ingestion (0036): pull the configured Shopify connection's canonical
  // data on its own cadence, so new orders and shipments arrive without anyone calling an
  // endpoint. Runs first so this tick's cost and invoice passes see what it ingested.
  if (shopifySyncEnabled()) {
    try {
      log.info('worker.shopify_sync_jobs', await runShopifySyncJobs(orgId()));
    } catch (e) {
      log.error('worker.shopify_sync_jobs_failed', { error: (e as { message?: string }).message ?? String(e) });
    }
  }
  // JOBS-01: carrier cost sync for first invoice parts, when GoSweetSpot is configured.
  // Failures a person must fix are recorded on the job as blocked with their reason.
  if (carrierCostSyncEnabled()) {
    try {
      log.info('worker.carrier_cost_jobs', await runCarrierCostJobs(orgId()));
    } catch (e) {
      log.error('worker.carrier_cost_jobs_failed', { error: (e as { message?: string }).message ?? String(e) });
    }
  }
  // Step 4c: draft each wholesale shipment's invoice part (0035). A part that cannot be
  // drafted yet is blocked with its reason and woken when what it waits for arrives.
  try {
    log.info('worker.invoice_part_jobs', await runInvoicePartJobs(orgId()));
  } catch (e) {
    log.error('worker.invoice_part_jobs_failed', { error: (e as { message?: string }).message ?? String(e) });
  }
  // UI-01 (0037): execute actions an operator approved in the console. executeApproved
  // re-checks the agent's grant, policy and material subject before each durable attempt.
  try {
    log.info('worker.approved_action_jobs', await runApprovedActionJobs(orgId()));
  } catch (e) {
    log.error('worker.approved_action_jobs_failed', { error: (e as { message?: string }).message ?? String(e) });
  }
  // AI-01 (0038): narrate the day over the deterministic rollup, when the key is set AND
  // the business's assistant.narrate grant (never seeded) is on. Runs last: it narrates
  // what this tick's passes produced; figures come from stored rows, never the model.
  if (narrationEnabled()) {
    try {
      log.info('worker.daily_briefing_jobs', await runDailyBriefingJobs(orgId()));
    } catch (e) {
      log.error('worker.daily_briefing_jobs_failed', { error: (e as { message?: string }).message ?? String(e) });
    }
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
