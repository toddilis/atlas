import 'dotenv/config';
import Fastify from 'fastify';
import { log } from '../platform/log.js';
import { handleFulfillmentWebhook, registerShopifyProjectors } from '../integrations/shopify/webhook.js';
import { registerShopifyTools } from '../integrations/shopify/tools.js';
import { registerStripeTools } from '../integrations/stripe/tools.js';
import { handleStripeWebhook, registerStripeProjectors } from '../integrations/stripe/webhook.js';
import { registerControllerTools } from '../agents/controller/tools/index.js';
import { bootAgents } from '../platform/orchestration/dispatch.js';
import { syncAll } from '../integrations/shopify/sync.js';
import { drain as drainOutbox } from '../platform/tools/outbox.js';
import { replay } from '../platform/events/projector.js';

async function boot() {
  // Wire platform components in dependency order: tools registered, projectors registered,
  // agents booted (which depends on the projector dispatcher being available).
  registerShopifyTools();
  registerStripeTools();
  registerControllerTools();
  registerShopifyProjectors();
  registerStripeProjectors();
  await bootAgents();
}

async function main() {
  await boot();

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

  app.get('/healthz', async () => ({ ok: true }));

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

  const port = Number(process.env.PORT ?? 3001);
  await app.listen({ port, host: '0.0.0.0' });
  log.info('api.listening', { port });
}

main().catch((e) => {
  log.error('api.fatal', { error: (e as Error).message, stack: (e as Error).stack });
  process.exit(1);
});
