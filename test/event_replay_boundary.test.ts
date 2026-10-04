import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { replay, registerProjector } from '../src/platform/events/projector.js';
import { registerAgent } from '../src/platform/agent/registry.js';
import { controllerAgent } from '../src/agents/controller/index.js';
import { isProjectionReplay } from '../src/platform/events/context.js';
import { registerTool, invokeTool } from '../src/platform/tools/registry.js';

const company = '52000000-0000-4000-8000-000000000001';
let projections = 0, effects = 0;
const requests: string[] = [];
const event = { id: '52000000-0000-4000-8000-000000000002', org_id: company, seq: 1,
  type: 'shopify.fulfillment.created', source: 'fixture', payload: { id: 'wholesale-dispatch' },
  subject_type: null, subject_id: null, occurred_at: '2026-10-01T00:00:00Z', appended_at: '2026-10-01T00:00:00Z', idempotency_key: 'fixture' };
const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://fixture'); requests.push(url.pathname);
  if (url.pathname === '/rest/v1/event_projections') assert.equal(req.method, 'GET', 'rebuild must not requeue live work');
  for await (const _ of req) { /* drain request */ }
  res.setHeader('Content-Type', 'application/json');
  if (url.pathname === '/rest/v1/event_log') res.end(JSON.stringify([event]));
  else if (url.pathname === '/rest/v1/event_projections') res.end(req.method === 'GET'
    ? JSON.stringify({ state: 'projected', attempts: 1, updated_at: '2026-10-01T00:00:00Z' }) : 'null');
  else if (url.pathname === '/rest/v1/agents') res.end('null');
  else { effects++; res.statusCode = 500; res.end('{"message":"business handler must not run"}'); }
});
before(async () => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  process.env.SUPABASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-only'; process.env.ATLAS_ORG_ID = company;
});
after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });
test('actual historical replay rebuilds reads, skips real Controller, and fences mutating projectors', async () => {
  await registerAgent(controllerAgent);
  registerProjector('shopify.fulfillment.created', async () => { assert.equal(isProjectionReplay(), true); projections++; });
  // A badly registered side-effecting projector is still fenced by the shared guard.
  registerTool({ name: 'fixture.replay-effect', defaultRisk: 'auto', mutating: true, execute: async () => { effects++; return {}; } });
  registerProjector('shopify.fulfillment.created', async () => { await invokeTool('fixture.replay-effect', {}, { agentName: 'fixture' }); });
  const result = await replay({ fromSeq: 1 });
  assert.equal(projections, 1);
  assert.equal(effects, 0);
  assert.equal(result.failed, 1);
  assert.equal(isProjectionReplay(), false);
  assert.deepEqual(new Set(requests), new Set(['/rest/v1/agents', '/rest/v1/event_log', '/rest/v1/event_projections']));
});
