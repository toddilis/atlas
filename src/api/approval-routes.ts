import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { orgId, supabase } from '../data/supabase.js';
import { decideApproval } from '../platform/control-plane/approvals.js';
import { encodeActionValue, loadBoundAction } from '../platform/control-plane/bound-actions.js';
import { executeApproved } from '../platform/tools/registry.js';

/** Registered only under /admin, behind server.ts's fail-closed bearer gate. */
export function registerApprovalRoutes(app: FastifyInstance): void {
  function actor(): string {
    const value = process.env.ATLAS_ADMIN_ACTOR_ID;
    if (!value?.trim()) throw new Error('ATLAS_ADMIN_ACTOR_ID must identify the trusted token owner');
    return value;
  }
  function body(input: unknown): unknown { return Buffer.isBuffer(input) ? (input.length ? JSON.parse(input.toString('utf8')) : {}) : input; }
  const params = z.object({ id: z.string().uuid() });
  app.post('/admin/actions/pause', async (request, reply) => {
    try {
      const input = z.object({ paused: z.boolean(), reason: z.string().min(1) }).strict().parse(body(request.body));
      const { error } = await supabase().rpc('set_action_pause', { p_org_id: orgId(), p_paused: input.paused, p_actor: actor(), p_reason: input.reason });
      if (error) throw error;
      return { ok: true };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });

  app.get('/admin/approvals/:id', async (request, reply) => {
    try {
      const { id } = params.parse(request.params);
      const action = await loadBoundAction(id);
      const { data, error } = await supabase().from('action_attempts').select('*').eq('org_id', orgId()).eq('action_id', action.id).order('attempt_number');
      if (error) throw error;
      return { action, attempts: data };
    } catch (error) { return reply.code(400).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post('/admin/approvals/:id/decision', async (request, reply) => {
    try {
      const { id } = params.parse(request.params);
      const input = z.object({ disposition: z.enum(['approved', 'rejected']), reason: z.string().optional() }).strict().parse(body(request.body));
      await decideApproval(id, input.disposition, actor(), input.reason);
      return { ok: true };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post('/admin/approvals/:id/execute', async (request, reply) => {
    try {
      const { id } = params.parse(request.params);
      // No tool, arguments, business or actor overrides are accepted from request data.
      z.object({}).strict().parse(body(request.body) ?? {});
      return encodeActionValue(await executeApproved(id, { companyId: orgId(), actorId: actor() }));
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post('/admin/actions/:id/revoke', async (request, reply) => {
    try {
      const { id } = params.parse(request.params);
      const input = z.object({ reason: z.string().min(1) }).strict().parse(body(request.body));
      const { error } = await supabase().rpc('revoke_bound_action', { p_org_id: orgId(), p_action_id: id, p_actor: actor(), p_reason: input.reason });
      if (error) throw error;
      return { ok: true };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
  app.post('/admin/actions/:id/reconcile', async (request, reply) => {
    try {
      const { id } = params.parse(request.params);
      const input = z.object({ state: z.enum(['CONFIRMED', 'FAILED']), evidence: z.record(z.unknown()).refine(v => Object.keys(v).length > 0) }).strict().parse(body(request.body));
      const { error } = await supabase().rpc('reconcile_bound_action', { p_org_id: orgId(), p_action_id: id, p_state: input.state, p_actor: actor(), p_evidence: encodeActionValue(input.evidence) });
      if (error) throw error;
      return { ok: true };
    } catch (error) { return reply.code(409).send({ error: error instanceof Error ? error.message : String(error) }); }
  });
}
