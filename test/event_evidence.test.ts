import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify from 'fastify';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { registerEvidenceRoutes } from '../src/api/evidence-routes.js';
import { parsePublishedEvent, projectNextEvent, publishEvent } from '../src/platform/events/delivery.js';
import { withProjectionReplay } from '../src/platform/events/context.js';
import { recordDecision } from '../src/platform/evidence/ledger.js';
import { readFileSync } from 'node:fs';

const company = '51000000-0000-4000-8000-000000000001';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/architecture/controller-chain.json', import.meta.url), 'utf8').replaceAll('fixture-wholesale', company));
const event = { event_id: 'decision-one', event_type: 'controller.decision.proposed', event_version: 1, company_id: company,
  connection_id: null, occurred_at: fixture.decision.created_at, observed_at: fixture.decision.created_at,
  producer: 'fixture', subject_type: 'Decision', subject_id: fixture.decision.decision_id, subject_version: 1,
  correlation_id: 'fixture-flow', causation_id: null, source_refs: [], evidence_refs: [], event_class: 'proposal', payload: fixture.decision };
const calls: string[] = [];
const server = createServer(async (req, res) => {
  let body = ''; for await (const part of req) body += part;
  const params = JSON.parse(body || '{}');
  assert.equal(params.p_org_id, company);
  calls.push(req.url!);
  res.setHeader('Content-Type', 'application/json');
  if (req.url === '/rest/v1/rpc/read_decision_evidence') {
    assert.equal(params.p_decision_id, 'decision-one');
    res.end(JSON.stringify({ company_id: company, state_at_decision: { amount_minor: '9007199254740993' }, actions: [], outcome_status: 'unknown' }));
  } else if (req.url === '/rest/v1/rpc/read_event_delivery') res.end('null');
  else if (req.url === '/rest/v1/rpc/claim_event_receipt') res.end(JSON.stringify({ event_id: 'decision-one', lease_token: '51000000-0000-4000-8000-000000000002', envelope: event }));
  else if (req.url === '/rest/v1/rpc/apply_event_projection') res.end('"applied"');
  else { res.statusCode = 400; res.end('{"message":"unexpected endpoint"}'); }
});
before(async () => {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  process.env.SUPABASE_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'synthetic-only'; process.env.ATLAS_ORG_ID = company;
});
after(async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); });

test('registered schema, exact scope and decision payload', () => {
  assert.equal(parsePublishedEvent(event, company).payload.company_id, company);
  assert.throws(() => parsePublishedEvent({ ...event, event_version: 2 }, company));
  assert.throws(() => parsePublishedEvent({ ...event, event_type: 'unregistered' }, company));
  assert.throws(() => parsePublishedEvent({ ...event, payload: { ...fixture.decision, state_snapshot_ref: { company_id: 'other', id: 'x', type: 'Snapshot' } } }, company), /cross-company/);
  assert.throws(() => parsePublishedEvent({ ...event, event_class: 'fact' }, company));
});
test('replay cannot publish evidence or fresh continuation', async () => {
  const before = calls.length;
  await assert.rejects(withProjectionReplay(() => publishEvent(event, 'one')), /forbidden during projection replay/);
  await assert.rejects(withProjectionReplay(() => recordDecision(fixture.decision, { amount_minor: '4' })), /forbidden during projection replay/);
  assert.equal(calls.length, before);
});
test('projection consumer only claims and atomically applies persisted envelope', async () => {
  const before = calls.length;
  assert.equal(await projectNextEvent('evidence.decisions', 'rebuild-1'), 'applied');
  assert.deepEqual(calls.slice(before), ['/rest/v1/rpc/claim_event_receipt', '/rest/v1/rpc/apply_event_projection']);
});
test('read routes fail closed and never accept request company override', async () => {
  const app = Fastify(); registerEvidenceRoutes(app);
  delete process.env.ATLAS_API_TOKEN;
  assert.equal((await app.inject('/admin/evidence/decisions/decision-one/1')).statusCode, 503);
  process.env.ATLAS_API_TOKEN = 'fixture-admin';
  assert.equal((await app.inject('/admin/evidence/decisions/decision-one/1')).statusCode, 401);
  const headers = { authorization: 'Bearer fixture-admin' };
  assert.equal((await app.inject({ url: '/admin/evidence/decisions/decision-one/1?company_id=other', headers })).statusCode, 400);
  const response = await app.inject({ url: '/admin/evidence/decisions/decision-one/1', headers });
  assert.equal(response.statusCode, 200);
  assert.equal(response.json().outcome_status, 'unknown');
  assert.equal(response.json().state_at_decision.amount_minor, '9007199254740993');
  assert.equal((await app.inject({ url: '/admin/evidence/events/missing', headers })).statusCode, 404);
  await app.close();
});
