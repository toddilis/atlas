import 'dotenv/config';
import Fastify from 'fastify';
import { log } from '../platform/log.js';
import { supabase, orgId } from '../data/supabase.js';
import { handleFulfillmentWebhook } from '../integrations/shopify/webhook.js';
import { handleStripeWebhook } from '../integrations/stripe/webhook.js';
import { bootPlatform } from '../platform/orchestration/boot.js';
import { syncAll } from '../integrations/shopify/sync.js';
import { drain as drainOutbox } from '../platform/tools/outbox.js';
import { replay } from '../platform/events/projector.js';
import { bearerAuthState } from './auth.js';

async function main() {
  await bootPlatform();

  const app = Fastify({
    logger: false,
    bodyLimit: 5 * 1024 * 1024,                // 5 MiB — generous for Shopify payloads
  });

  // Shopify webhooks require the raw body for HMAC verification. We parse JSON ourselves
  // inside the handler.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (_req, body, done) => done(null, body),
  );

  // /admin/* requires `Authorization: Bearer $ATLAS_API_TOKEN` (PR-L). Webhook routes stay
  // open here because they carry their own cryptographic auth (Shopify HMAC, Stripe
  // signature); /healthz stays open for load-balancer probes. Fails closed: with no token
  // configured the admin surface answers 503 rather than running unauthenticated.
  app.addHook('onRequest', async (req, reply) => {
    if (!req.url.startsWith('/admin/')) return;
    const state = bearerAuthState(req.headers.authorization, process.env.ATLAS_API_TOKEN);
    if (state === 'unconfigured') {
      return reply.code(503).send({ ok: false, error: 'ATLAS_API_TOKEN not configured' });
    }
    if (state === 'unauthorized') {
      return reply.code(401).send({ ok: false, error: 'unauthorized' });
    }
  });

  // Liveness: process is up. Readiness (below) is what deploy health checks should use.
  app.get('/healthz', async () => ({ ok: true }));

  // Readiness: config present AND the database answers. Fly's http check points here
  // (fly.toml), so a machine with broken env or an unreachable Supabase is taken out of
  // rotation instead of 200-ing while every webhook fails behind it.
  app.get('/readyz', async (_req, reply) => {
    const missing = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ATLAS_ORG_ID'].filter(
      (k) => !process.env[k],
    );
    if (missing.length > 0) {
      return reply.code(503).send({ ok: false, error: `missing env: ${missing.join(', ')}` });
    }
    try {
      const { error } = await supabase()
        .from('orgs')
        .select('id')
        .eq('id', orgId())
        .limit(1);
      if (error) throw error;
      return reply.send({ ok: true });
    } catch (e) {
      return reply.code(503).send({ ok: false, error: (e as Error).message });
    }
  });

  app.post('/webhooks/shopify/fulfillments', async (req, reply) => {
    const result = await handleFulfillmentWebhook(
      req.body as Buffer,
      req.headers as Record<string, string | undefined>,
    );
    return reply.code(result.status).send({ ok: result.ok, message: result.message });
  });

  app.post('/webhooks/stripe', async (req, reply) => {
    const result = await handleStripeWebhook(
      req.body as Buffer,
      req.headers as Record<string, string | undefined>,
    );
    return reply.code(result.status).send({ ok: result.ok, message: result.message });
  });

  // Manual sync trigger — useful in dev. In production this would be scheduled, not exposed.
  app.post('/admin/shopify/sync', async (_req, reply) => {
    try {
      const result = await syncAll();
      return reply.send({ ok: true, ...result });
    } catch (e) {
      return reply.code(500).send({ ok: false, error: (e as Error).message });
    }
  });

  // Manual outbox drain — same dev convenience as the sync trigger. Production wires this
  // to a scheduled job (cron / supabase scheduled function); leaving the admin endpoint
  // here keeps the loop visible during local development.
  app.post('/admin/outbox/drain', async (_req, reply) => {
    try {
      const processed = await drainOutbox();
      return reply.send({ ok: true, processed });
    } catch (e) {
      return reply.code(500).send({ ok: false, error: (e as Error).message });
    }
  });

  // Manual projection replay — drains outstanding (failed / stale-pending) projections in
  // seq order; pass fromSeq to rebuild read-models from a point in the spine. The worker
  // (PR-R) runs the drain on a schedule; this keeps recovery operable until then.
  app.post('/admin/replay', async (req, reply) => {
    try {
      const raw = req.body as Buffer | undefined;
      const body = raw?.length
        ? (JSON.parse(raw.toString('utf8')) as { limit?: number; fromSeq?: number })
        : {};
      const summary = await replay({ limit: body.limit, fromSeq: body.fromSeq });
      return reply.send({ ok: true, ...summary });
    } catch (e) {
      return reply.code(500).send({ ok: false, error: (e as Error).message });
    }
  });

  // Graceful shutdown: stop accepting connections, let in-flight requests finish
  // (Fastify's close() drains them), then exit. Fly sends SIGTERM on deploy/stop.
  let shuttingDown = false;
  const shutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info('api.shutdown_requested', { signal });
    app
      .close()
      .then(() => {
        log.info('api.stopped');
        process.exit(0);
      })
      .catch((e) => {
        log.error('api.shutdown_failed', { error: (e as Error).message });
        process.exit(1);
      });
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });
  log.info('api.listening', { port });
}

main().catch((e) => {
  log.error('api.fatal', { error: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});
