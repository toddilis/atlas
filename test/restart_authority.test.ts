import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';

test('fresh processes preserve revoked tool grants and disabled agents at boot', async () => {
  const rows = new Map<string, Record<string, unknown>>();
  const org = '50000000-0000-4000-8000-000000000001';
  rows.set('agents', { enabled: false });
  rows.set('tool_grants', { enabled: false, risk: 'approve_required' });
  let writes = 0;
  const server = createServer(async (request, response) => {
    const path = new URL(request.url!, 'http://127.0.0.1').pathname;
    let body = ''; for await (const chunk of request) body += chunk;
    const table = path.split('/').pop()!;
    if (request.method !== 'POST' || !rows.has(table)) { response.writeHead(500).end(); return; }
    const proposed = JSON.parse(body);
    assert.equal(proposed.org_id, org);
    if (!request.headers.prefer?.includes('resolution=ignore-duplicates')) rows.set(table, proposed);
    writes++;
    response.writeHead(201, { 'content-type': 'application/json' }).end('null');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const source = `
    import { registerAgent } from './src/platform/agent/registry.ts';
    import { grantTool } from './src/platform/tools/grants.ts';
    await registerAgent({ name:'fixture',domain:'fixture',kind:'worker',triggers:[],tools:[],readScope:[],onEvent:async()=>{} });
    await grantTool({ agentName:'fixture',toolName:'fixture.write',risk:'auto',enabled:true });
  `;
  try {
    for (let restart = 0; restart < 2; restart++) {
      await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', source], {
          env: { ...process.env, SUPABASE_URL: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
            SUPABASE_SERVICE_ROLE_KEY: 'fixture-only', ATLAS_ORG_ID: org },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let output = '';
        child.stdout.on('data', data => output += data);
        child.stderr.on('data', data => output += data);
        child.on('error', reject);
        child.on('exit', code => code === 0 ? resolve() : reject(new Error(output)));
      });
      assert.deepEqual(rows.get('agents'), { enabled: false });
      assert.deepEqual(rows.get('tool_grants'), { enabled: false, risk: 'approve_required' });
    }
    assert.equal(writes, 4);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
