import test from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { registerApprovalRoutes } from '../src/api/approval-routes.js';

test('approval read/action routes enforce authentication when mounted independently', async () => {
  const saved = process.env.ATLAS_API_TOKEN;
  const app = Fastify();
  registerApprovalRoutes(app);
  const id = '20000000-0000-4000-8000-000000000002';
  const requests = [
    { method: 'GET' as const, url: `/admin/approvals/${id}` },
    ...['decision', 'execute'].map(action => ({ method: 'POST' as const, url: `/admin/approvals/${id}/${action}` })),
    ...['revoke', 'reconcile'].map(action => ({ method: 'POST' as const, url: `/admin/actions/${id}/${action}` })),
    { method: 'POST' as const, url: '/admin/actions/pause' },
  ];
  try {
    for (const request of requests) {
      delete process.env.ATLAS_API_TOKEN;
      assert.equal((await app.inject(request)).statusCode, 503);
      process.env.ATLAS_API_TOKEN = 'synthetic-test-token';
      assert.equal((await app.inject(request)).statusCode, 401);
      assert.equal((await app.inject({ ...request, headers: { authorization: 'Bearer forged' } })).statusCode, 401);
    }
    const response = await app.inject({ method: 'POST', url: `/admin/approvals/${id}/execute`,
      headers: { authorization: 'Bearer synthetic-test-token' },
      payload: { tool: 'forged', companyId: id, actorId: 'forged', input: {} } });
    assert.equal(response.statusCode, 409);
    assert.match(response.body, /unrecognized_keys/);
  } finally {
    await app.close();
    if (saved === undefined) delete process.env.ATLAS_API_TOKEN; else process.env.ATLAS_API_TOKEN = saved;
  }
});
