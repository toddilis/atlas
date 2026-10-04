import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { execute } from '../src/agents/controller/tools/issue_invoice.js';
import { KnownNoEffectError } from '../src/platform/control-plane/bound-actions.js';

test('explicit transactional invoice refusal is retryable no-effect; unknown transport is not', async () => {
  let code = 'P0001';
  let requests = 0;
  const server = createServer((request, response) => {
    requests++;
    assert.equal(request.url, '/rest/v1/rpc/issue_bound_invoice');
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code, message: 'current policy blocks action' }));
  });
  const saved = Object.fromEntries(['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ATLAS_ORG_ID'].map(key => [key, process.env[key]]));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.SUPABASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-only';
  process.env.ATLAS_ORG_ID = '50000000-0000-4000-8000-000000000001';
  const input = { invoiceId: 'invoice', amount: 1n, currency: 'NZD', accountId: 'account', fulfillmentEventId: 'fulfillment' };
  const ctx = { agentName: 'controller', actionId: 'action', executionId: 'attempt' };
  try {
    await assert.rejects(execute(input, ctx), error => error instanceof KnownNoEffectError && error.evidence.sqlstate === 'P0001');
    code = 'UNKNOWN';
    await assert.rejects(execute(input, ctx), error => !(error instanceof KnownNoEffectError));
    assert.equal(requests, 2); // No domain event is emitted for either failure.
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});
