import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { invokeTool, registerTool } from '../src/platform/tools/registry.js';
import type { RiskTier } from '../src/platform/control-plane/types.js';

// Exercise the real registry, policy engine and Supabase HTTP client against a
// loopback PostgREST fixture. No production client replacement or credentials.
const organization = '00000000-0000-4000-8000-000000000001';
const approvalId = '00000000-0000-4000-8000-000000000002';
const tool = 'fixture.entitlement';
const agent = 'fixture-agent';
const context = { agentName: agent, subjectType: 'fixture', subjectId: 'subject-1' };
const input = { amount: 200 };
let grant: { enabled: boolean; risk: RiskTier } | null;
let config: Record<string, unknown> | null;
let grantError = false;
let requests: Array<{ method: string; path: string; query: URLSearchParams }>;
let audits: Array<Record<string, unknown>>;
let approvals: Array<Record<string, unknown>>;
let executions = 0;
let extractions = 0;

const server = createServer(async (request, response) => {
  const url = new URL(request.url!, 'http://127.0.0.1');
  requests.push({ method: request.method!, path: url.pathname, query: url.searchParams });
  response.setHeader('content-type', 'application/json');
  if (request.method === 'GET' && url.pathname === '/rest/v1/tool_grants') {
    response.statusCode = grantError ? 503 : 200;
    if (grantError) response.setHeader('retry-after', '0');
    response.end(JSON.stringify(grantError ? { message: 'fixture grant lookup unavailable' } : grant ? [grant] : []));
    return;
  }
  if (request.method === 'GET' && url.pathname === '/rest/v1/policy_rules') {
    response.end(JSON.stringify(config ? [{ config }] : []));
    return;
  }
  let body = '';
  for await (const chunk of request) body += chunk;
  if (request.method === 'POST' && url.pathname === '/rest/v1/audit_log') {
    audits.push(JSON.parse(body));
    response.end('null');
  } else if (request.method === 'POST' && url.pathname === '/rest/v1/approvals') {
    approvals.push(JSON.parse(body));
    response.end(JSON.stringify({ id: approvalId }));
  } else {
    response.statusCode = 404;
    response.end(JSON.stringify({ message: 'Unexpected fixture endpoint' }));
  }
});

const savedEnvironment = Object.fromEntries(
  ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ATLAS_ORG_ID'].map((key) => [key, process.env[key]]),
);
before(async () => {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  process.env.SUPABASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-only-not-a-live-key';
  process.env.ATLAS_ORG_ID = organization;
});
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [key, value] of Object.entries(savedEnvironment)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
beforeEach(() => {
  grant = { enabled: true, risk: 'auto' };
  config = {};
  grantError = false;
  requests = []; audits = []; approvals = [];
  executions = 0; extractions = 0;
});

function install(mutating = true, defaultRisk: RiskTier = 'notify', withExtractor = true) {
  registerTool<typeof input, string>({
    name: tool, mutating, defaultRisk,
    policyInput: withExtractor ? (value) => {
      extractions++;
      return { subjectType: 'fixture', subjectId: context.subjectId, amount: BigInt(value.amount),
        currency: 'NZD', attributes: {} };
    } : undefined,
    execute: async () => { executions++; return 'fixture executed'; },
  });
}

function assertGrantLookup() {
  const lookup = requests.filter((request) => request.path === '/rest/v1/tool_grants');
  assert.equal(lookup.length, 1, 'one entitlement lookup per invocation');
  assert.equal(requests[0], lookup[0], 'entitlement precedes policy and all side effects');
  assert.equal(lookup[0]!.query.get('org_id'), `eq.${organization}`);
  assert.equal(lookup[0]!.query.get('agent_name'), `eq.${agent}`);
  assert.equal(lookup[0]!.query.get('tool_name'), `eq.${tool}`);
}

for (const scenario of [
  { name: 'missing mutation grant with configured allow', mutating: true, missing: true, policy: {} },
  { name: 'disabled mutation grant with configured allow', mutating: true, missing: false, policy: {} },
  { name: 'disabled mutation grant with configured escalation', mutating: true, missing: false,
    policy: { approvalThreshold: { amount: '100' } } },
  { name: 'disabled read grant with configured allow', mutating: false, missing: false, policy: {} },
  { name: 'disabled read grant without policy', mutating: false, missing: false, policy: null },
  { name: 'missing mutation grant without policy', mutating: true, missing: true, policy: null },
  { name: 'disabled mutation grant without policy', mutating: true, missing: false, policy: null },
]) {
  test(scenario.name + ' refuses dispatch and does not request approval', async () => {
    grant = scenario.missing ? null : { enabled: false, risk: 'auto' };
    config = scenario.policy;
    install(scenario.mutating);
    await assert.rejects(invokeTool(tool, input, context),
      scenario.missing ? /no tool grant for mutating tool: fixture-agent/ : /tool grant disabled: fixture-agent/);
    assertGrantLookup();
    assert.equal(requests.length, 1, 'no policy reads or persistence after entitlement denial');
    assert.equal(extractions, 0);
    assert.equal(executions, 0);
    assert.deepEqual(approvals, []);
    assert.deepEqual(audits, []);
  });
}

for (const scenario of [
  { name: 'enabled configured allow preserves policy precedence over approval risk', grantRisk: 'approve_required',
    policy: {}, expected: 'executed', decision: 'allow', risk: 'auto' },
  { name: 'enabled configured escalation still requests approval', grantRisk: 'auto',
    policy: { approvalThreshold: { amount: '100' } }, expected: 'pending_approval', decision: 'escalate', risk: 'approve_required' },
  { name: 'enabled configured block still refuses execution', grantRisk: 'auto',
    policy: { perTransactionCap: { amount: '100' } }, expected: 'blocked', decision: 'block', risk: 'approve_required' },
  { name: 'legacy auto still executes', grantRisk: 'auto', policy: null,
    expected: 'executed', decision: null, risk: 'auto' },
  { name: 'legacy notify still executes', grantRisk: 'notify', policy: null,
    expected: 'executed', decision: null, risk: 'notify' },
  { name: 'legacy approval risk still requests approval', grantRisk: 'approve_required', policy: null,
    expected: 'pending_approval', decision: 'escalate', risk: 'approve_required' },
] as const) {
  test(scenario.name, async () => {
    grant = { enabled: true, risk: scenario.grantRisk };
    config = scenario.policy;
    install();
    const result = await invokeTool(tool, input, context);
    assertGrantLookup();
    assert.equal(result.status, scenario.expected);
    assert.equal(result.decision?.decision ?? null, scenario.decision);
    assert.equal(executions, scenario.expected === 'executed' ? 1 : 0);
    assert.equal(approvals.length, scenario.expected === 'pending_approval' ? 1 : 0);
    assert.equal(audits.length, 1);
    assert.equal(audits[0]!.org_id, organization);
    assert.equal(audits[0]!.agent_name, agent);
    assert.equal(audits[0]!.tool_name, tool);
    assert.equal(audits[0]!.outcome, scenario.expected === 'executed' ? 'success' : 'blocked');
    assert.equal(audits[0]!.risk, scenario.risk);
  });
}

for (const configured of [true, false]) {
  test(`read without a grant retains its ${configured ? 'configured policy' : 'legacy default'} behavior`, async () => {
    grant = null;
    config = configured ? {} : null;
    install(false, 'notify');
    const result = await invokeTool(tool, input, context);
    assertGrantLookup();
    assert.equal(result.status, 'executed');
    assert.equal(executions, 1);
    assert.equal(audits[0]!.risk, configured ? 'auto' : 'notify');
  });
}

test('a tool without an extractor still enforces its grant and uses legacy risk', async () => {
  grant = { enabled: true, risk: 'approve_required' };
  install(true, 'auto', false);
  assert.equal((await invokeTool(tool, input, context)).status, 'pending_approval');
  assertGrantLookup();
  assert.equal(requests.some((request) => request.path === '/rest/v1/policy_rules'), false);
  assert.equal(executions, 0);
});

test('a grant lookup failure fails closed before policy or execution', async () => {
  grantError = true;
  install();
  await assert.rejects(invokeTool(tool, input, context), (error: unknown) =>
    (error as { message: string }).message === 'fixture grant lookup unavailable');
  // The real client may retry this read. None of those attempts can fall
  // through to policy, approvals, audit success or the handler.
  assert.ok(requests.length > 0);
  assert.ok(requests.every((request) => request.method === 'GET' && request.path === '/rest/v1/tool_grants'));
  assert.equal(extractions, 0);
  assert.equal(executions, 0);
  assert.equal(approvals.length, 0);
});

test('revoking a grant between configured-policy invocations takes effect on the next call', async () => {
  install();
  assert.equal((await invokeTool(tool, input, context)).status, 'executed');
  grant = { enabled: false, risk: 'auto' };
  await assert.rejects(invokeTool(tool, input, context), /tool grant disabled/);
  assert.equal(executions, 1);
  assert.equal(extractions, 1);
  assert.equal(audits.length, 1);
  assert.equal(approvals.length, 0);
  assert.equal(requests.filter((request) => request.path === '/rest/v1/tool_grants').length, 2);
  assert.equal(requests.filter((request) => request.path === '/rest/v1/policy_rules').length, 1);
});
