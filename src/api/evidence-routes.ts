import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { bearerAuthState } from './auth.js';
import { readDecisionEvidence } from '../platform/evidence/ledger.js';
import { readEventDelivery } from '../platform/events/delivery.js';

/** Server-only reads; fail closed independently of the parent server's gate. */
export function registerEvidenceRoutes(app: FastifyInstance): void {
  app.get('/admin/evidence/decisions/:id/:revision', async (request, reply) => {
    const auth = bearerAuthState(request.headers.authorization, process.env.ATLAS_API_TOKEN);
    if (auth !== 'ok') return reply.code(auth === 'unconfigured' ? 503 : 401).send({ error: 'evidence read unauthorized or unconfigured' });
    const params = z.object({ id: z.string().min(1).max(200), revision: z.coerce.number().int().positive().safe() }).safeParse(request.params);
    if (!params.success || Object.keys(request.query as object).length) return reply.code(400).send({ error: 'invalid evidence request' });
    try {
      const result = await readDecisionEvidence(params.data.id, params.data.revision);
      return result === null ? reply.code(404).send({ error: 'evidence not found' }) : result;
    } catch { return reply.code(503).send({ error: 'evidence temporarily unavailable' }); }
  });
  app.get('/admin/evidence/events/:id', async (request, reply) => {
    const auth = bearerAuthState(request.headers.authorization, process.env.ATLAS_API_TOKEN);
    if (auth !== 'ok') return reply.code(auth === 'unconfigured' ? 503 : 401).send({ error: 'evidence read unauthorized or unconfigured' });
    const params = z.object({ id: z.string().min(1).max(200) }).safeParse(request.params);
    if (!params.success || Object.keys(request.query as object).length) return reply.code(400).send({ error: 'invalid evidence request' });
    try {
      const result = await readEventDelivery(params.data.id);
      return result === null ? reply.code(404).send({ error: 'event not found' }) : result;
    } catch { return reply.code(503).send({ error: 'event delivery temporarily unavailable' }); }
  });
}
