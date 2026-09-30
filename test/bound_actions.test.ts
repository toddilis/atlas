import test, { before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { executeApproved, registerTool } from '../src/platform/tools/registry.js';
import { encodeActionValue, decodeActionValue, KnownNoEffectError } from '../src/platform/control-plane/bound-actions.js';
import { withProjectionReplay } from '../src/platform/events/context.js';
import type { Json } from '../src/data/database.types.js';

const org = '20000000-0000-4000-8000-000000000001';
const approval = '20000000-0000-4000-8000-000000000002';
const action = '20000000-0000-4000-8000-000000000003';
const execution = '20000000-0000-4000-8000-000000000004';
const subject = '20000000-0000-4000-8000-000000000005';
const policyId = '20000000-0000-4000-8000-000000000006';
const actor = { companyId: org, actorId: 'fixture-operator' };
let stored: Record<string, unknown>;
let currentPolicy: Record<string, unknown> | null;
let grant: boolean, paused: boolean, claimed: boolean, expired: boolean, revoked: boolean;
let snapshot: Record<string, unknown>;
let seenInput: unknown, seenContext: unknown;
let finish: Record<string, unknown> | null;
let mode: 'ok' | 'unknown' | 'no-effect' | 'no-proof';
let calls: string[];

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1');
  calls.push(url.pathname);
  res.setHeader('content-type', 'application/json');
  let text = ''; for await (const chunk of req) text += chunk;
  const body = text ? JSON.parse(text) : {};
  const reply = (value: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(value)); };
  if (url.pathname === '/rest/v1/approved_actions') {
    assert.equal(url.searchParams.get('org_id'), `eq.${org}`);
    assert.equal(url.searchParams.get('approval_id'), `eq.${approval}`);
    return reply([{ id: action, org_id: org, approval_id: approval, intent: stored, state: 'AUTHORISED' }]);
  }
  if (url.pathname === '/rest/v1/tool_grants') return reply(grant ? [{ enabled: true, risk: 'approve_required' }] : []);
  if (url.pathname === '/rest/v1/rpc/assert_action_authority') return paused ? reply({ message: 'business actions paused' }, 400) : reply(null);
  if (url.pathname === '/rest/v1/rpc/current_action_policy') return reply(currentPolicy);
  if (url.pathname === '/rest/v1/rpc/claim_bound_action') {
    if (expired || revoked || claimed) return reply({ message: 'approval expired, revoked or already claimed' }, 400);
    assert.equal(body.p_org_id, org); assert.equal(body.p_actor, actor.actorId);
    claimed = true;
    return reply({ action_id: action, execution_id: execution, idempotency_key: `${org}:${action}:1`, intent: stored });
  }
  if (url.pathname === '/rest/v1/rpc/finish_bound_action') { finish = body; return reply(null); }
  return reply({ message: 'unexpected boundary endpoint' }, 400);
});
const keys = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'ATLAS_ORG_ID'];
const saved = Object.fromEntries(keys.map(key => [key, process.env[key]]));
before(async () => {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  process.env.SUPABASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-only'; process.env.ATLAS_ORG_ID = org;
  registerTool<{ amount: bigint }, { reference: string }>({
    name: 'fixture.bound', defaultRisk: 'approve_required', mutating: true,
    policyInput: input => ({ subjectType: 'fixture', subjectId: subject, amount: input.amount, currency: 'NZD', attributes: {} }),
    approvalSnapshot: async () => snapshot,
    execute: async (input, context) => {
      seenInput = input; seenContext = context;
      if (mode === 'unknown') throw new Error('provider timed out');
      if (mode === 'no-effect') throw new KnownNoEffectError('provider definitively refused', { refusal: 'no effect' });
      return { reference: 'confirmed-record' };
    },
    confirmation: result => mode === 'no-proof' ? null : { persisted_record: result.reference },
  });
});
after(async () => {
  server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  for (const key of keys) { if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key]; }
});
beforeEach(() => {
  grant = true; paused = claimed = expired = revoked = false;
  snapshot = { revision: 1, destination: 'fixture' }; mode = 'ok'; currentPolicy = null;
  seenInput = seenContext = undefined; finish = null; calls = [];
  stored = { schema_version: 1, org_id: org, agent_name: 'fixture-agent', tool_name: 'fixture.bound',
    subject_type: 'fixture', subject_id: subject, input: encodeActionValue({ amount: 9007199254740993n }),
    subject_snapshot: { ...snapshot }, policy_snapshot: null };
});

test('executes persisted intent and preserves bigint across storage and handler boundary', async () => {
  const result = await executeApproved(approval, actor);
  assert.equal(result.status, 'CONFIRMED');
  assert.deepEqual(seenInput, { amount: 9007199254740993n });
  assert.deepEqual(seenContext, { companyId: org, agentName: 'fixture-agent', subjectType: 'fixture', subjectId: subject,
    actionId: action, executionId: execution, idempotencyKey: `${org}:${action}:1` });
  assert.equal(finish!.p_state, 'CONFIRMED');
  assert.ok(calls.indexOf('/rest/v1/rpc/assert_action_authority') < calls.indexOf('/rest/v1/rpc/claim_bound_action'));
});
for (const scenario of ['wrong-company', 'missing-grant', 'paused', 'changed-subject', 'changed-policy', 'expired', 'revoked', 'duplicate'] as const) {
  test(`refuses ${scenario} before calling the business handler`, async () => {
    let trusted = actor;
    if (scenario === 'wrong-company') trusted = { ...actor, companyId: 'other' };
    if (scenario === 'missing-grant') grant = false;
    if (scenario === 'paused') paused = true;
    if (scenario === 'changed-subject') snapshot = { ...snapshot, destination: 'different' };
    if (scenario === 'changed-policy') currentPolicy = { id: policyId, version: 2, config: {} };
    if (scenario === 'expired') expired = true;
    if (scenario === 'revoked') revoked = true;
    if (scenario === 'duplicate') claimed = true;
    await assert.rejects(executeApproved(approval, trusted));
    assert.equal(seenInput, undefined); assert.equal(finish, null);
  });
}
test('a current blocking policy is enforced even when its version matches the approval', async () => {
  currentPolicy = { id: policyId, version: 1, config: { perTransactionCap: { amount: '100' } } };
  stored.policy_snapshot = currentPolicy;
  await assert.rejects(executeApproved(approval, actor), /current policy blocks/);
  assert.equal(claimed, false); assert.equal(seenInput, undefined);
});
test('a still-applicable threshold escalation is authorized by the persisted approval', async () => {
  currentPolicy = { id: policyId, version: 1, config: { approvalThreshold: { amount: '100' } } };
  stored.policy_snapshot = currentPolicy;
  assert.equal((await executeApproved(approval, actor)).status, 'CONFIRMED');
});
test('an unknown provider error is durably unresolved and cannot be re-executed', async () => {
  mode = 'unknown';
  await assert.rejects(executeApproved(approval, actor), /timed out/);
  assert.equal(finish!.p_state, 'UNRESOLVED');
  await assert.rejects(executeApproved(approval, actor), { message: 'approval expired, revoked or already claimed' });
});
test('only explicit no-effect evidence permits the failed state', async () => {
  mode = 'no-effect';
  await assert.rejects(executeApproved(approval, actor), /definitively refused/);
  assert.equal(finish!.p_state, 'FAILED');
  assert.deepEqual(finish!.p_evidence, { refusal: 'no effect' });
});
test('a returned handler value without confirmation evidence remains unresolved', async () => {
  mode = 'no-proof'; assert.equal((await executeApproved(approval, actor)).status, 'UNRESOLVED');
  assert.equal(finish!.p_state, 'UNRESOLVED');
});
test('projection replay cannot execute an approved action', async () => {
  await assert.rejects(withProjectionReplay(() => executeApproved(approval, actor)), /replay/i);
  assert.equal(calls.length, 0);
});
test('codec rejects ambiguous tagged objects and unsafe numeric amounts', () => {
  assert.throws(() => encodeActionValue({ amount: Number.MAX_SAFE_INTEGER + 1 }), /unsafe/);
  assert.throws(() => encodeActionValue({ amount: { $atlas_bigint: '10' } }), /reserved/);
  assert.deepEqual(decodeActionValue(encodeActionValue({ values: [1n, '1', 1] })), { values: [1n, '1', 1] });
  assert.throws(() => decodeActionValue({ $atlas_bigint: 'bad' } as Json), /invalid persisted/);
});
