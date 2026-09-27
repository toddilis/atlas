import test, { before, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHmac, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { handleFulfillmentWebhook, projectFulfillment, registerShopifyProjectors } from '../src/integrations/shopify/webhook.js';
import { configuredShopifyDispatchContext, projectShopifyDispatch } from '../src/integrations/shopify/dispatch.js';
import { syncOrders } from '../src/integrations/shopify/sync.js';
import { replay } from '../src/platform/events/projector.js';
import { toAppendedEvent } from '../src/platform/events/row.js';
import { readDispatch } from '../src/platform/dispatch/read.js';
import { execute as draftInvoice } from '../src/agents/controller/tools/draft_invoice.js';

// Real Supabase HTTP client + application handlers against a loopback PostgREST fixture.
// SQL behavior is independently exercised by verify-dispatch.sql and real concurrent sessions.
const orgA = '10000000-0000-4000-8000-000000000001';
const orgB = '10000000-0000-4000-8000-000000000002';
const source = '20000000-0000-4000-8000-000000000001';
const dispatch = '30000000-0000-4000-8000-000000000001';
const secret = 'synthetic-webhook-secret';
const payload = { id: 1001, order_id: 900, status: 'success', updated_at: '2026-09-01T00:00:00Z',
  line_items: [{ id: 901, quantity: 40 }] };
type Row = Record<string, unknown>;
let requests: Array<{ method: string; path: string; query: URLSearchParams; body: unknown }> = [];
let events: Row[] = [];
let states = new Map<string, Row>();
let projectionError: string | null = null;
let bindingError = false;
let orders: Row[] = [];
let baseUrl: string;
const actualFetch = globalThis.fetch;

const server = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://127.0.0.1');
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = raw ? JSON.parse(raw) : null;
  requests.push({ method: req.method!, path: url.pathname, query: url.searchParams, body });
  res.setHeader('content-type', 'application/json');
  const send = (data: unknown, status = 200) => { res.statusCode = status; res.end(JSON.stringify(data)); };
  const matches = (row: Row) => ['org_id', 'id', 'idempotency_key'].every((key) => {
    const filter = url.searchParams.get(key); return !filter || filter === `eq.${row[key]}`;
  });
  if (url.pathname.endsWith('/orders.json')) return send({ orders });
  if (url.pathname === '/rest/v1/event_log') {
    if (req.method === 'POST') {
      if (events.some((event) => event.idempotency_key === body.idempotency_key)) {
        return send({ code: '23505', message: 'duplicate event' }, 409);
      }
      const row = { ...body, id: randomUUID(), seq: events.length + 1, appended_at: new Date().toISOString() };
      events.push(row); states.set(row.id, { state: 'pending', attempts: 0, updated_at: row.appended_at });
      return send(row, 201);
    }
    const rows = events.filter(matches);
    return send(req.headers.accept?.includes('vnd.pgrst.object') ? rows[0] : rows);
  }
  if (url.pathname === '/rest/v1/event_projections') {
    const id = url.searchParams.get('event_id')?.replace('eq.', '');
    if (req.method === 'PATCH') { states.set(id!, body); return send(null); }
    if (id) return send(states.has(id) ? [states.get(id)] : []);
    return send(events.filter((event) => matches(event) && states.get(event.id as string)?.state !== 'projected')
      .map((event) => ({ ...states.get(event.id as string), event_log: event })));
  }
  if (url.pathname === '/rest/v1/rpc/project_shopify_dispatch') {
    return projectionError ? send({ code: 'P0001', message: projectionError }, 400) : send(dispatch);
  }
  if (url.pathname === '/rest/v1/rpc/bind_shopify_dispatch_source') {
    return bindingError ? send({ code: 'P0001', message: 'Shopify connection binding mismatch' }, 400) : send(source);
  }
  if (url.pathname === '/rest/v1/shopify_orders' && req.method === 'POST') {
    return send(body.map((row: Row) => ({ id: '40000000-0000-4000-8000-000000000001', shopify_order_id: row.shopify_order_id })));
  }
  if (url.pathname === '/rest/v1/shopify_order_lines' && req.method === 'POST') return send(null);
  if (url.pathname === '/rest/v1/fulfillment_events') return send([{
    id: 'event', shopify_order_id: 'order', shopify_fulfillment_id: 'fulfillment', account_id: 'account', route: 'wholesale',
  }]);
  if (url.pathname === '/rest/v1/shopify_fulfillments') return send([{ dispatch_id: dispatch }]);
  if (url.pathname === '/rest/v1/dispatches') {
    return send(url.searchParams.get('org_id') === `eq.${orgA}` && url.searchParams.get('source_id') === `eq.${source}`
      ? [{ id: dispatch, org_id: orgA, source_id: source, state: 'eligible', lines: [{ id: 'line', quantity: 40 }] }] : []);
  }
  if (url.pathname === '/rest/v1/dispatch_lines') return send([{ id: 'line', quantity: 40 }]);
  return send({ message: 'unexpected fixture endpoint' }, 404);
});

const saved = Object.fromEntries(['ATLAS_ORG_ID','SUPABASE_URL','SUPABASE_SERVICE_ROLE_KEY','SHOPIFY_SHOP_DOMAIN',
  'SHOPIFY_WEBHOOK_SECRET','SHOPIFY_ADMIN_API_TOKEN'].map((key) => [key, process.env[key]]));
before(async () => {
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  process.env.SUPABASE_URL = baseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fixture-only';
  process.env.SHOPIFY_WEBHOOK_SECRET = secret;
  process.env.SHOPIFY_ADMIN_API_TOKEN = 'fixture-only';
  // Redirect only the synthetic Shopify host; all requests still use real HTTP.
  globalThis.fetch = ((input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input.toString() : input.url);
    return actualFetch(url.hostname === 'fixture-a.myshopify.com' ? `${baseUrl}${url.pathname}${url.search}` : input, init);
  }) as typeof fetch;
  registerShopifyProjectors();
});
beforeEach(() => {
  process.env.ATLAS_ORG_ID = orgA; process.env.SHOPIFY_SHOP_DOMAIN = 'fixture-a.myshopify.com';
  requests = []; events = []; states = new Map(); projectionError = null; bindingError = false; orders = [];
});
after(async () => {
  globalThis.fetch = actualFetch;
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  for (const [key,value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
function signed(value: unknown, shop = 'fixture-a.myshopify.com') {
  const body = JSON.stringify(value);
  return { body, headers: { 'x-shopify-shop-domain': shop,
    'x-shopify-hmac-sha256': createHmac('sha256', secret).update(body).digest('base64') } };
}
async function deliver(value: unknown = payload, shop?: string) {
  const { body, headers } = signed(value, shop); return handleFulfillmentWebhook(body, headers);
}
function rpcBodies() { return requests.filter((r) => r.path.endsWith('/rpc/project_shopify_dispatch')).map((r) => r.body as Row); }

test('authenticated webhook persists trusted business/connection and exact dispatched quantity', async () => {
  assert.equal((await deliver({ ...payload, org_id: orgB, _atlas_connection: 'attacker.myshopify.com' })).status, 200);
  assert.equal(events[0]!.org_id, orgA);
  assert.equal((events[0]!.payload as Row)._atlas_connection, 'fixture-a.myshopify.com');
  const rpc = rpcBodies()[0]!;
  assert.equal(rpc.p_org_id, orgA);
  assert.equal(rpc.p_connection_key, 'fixture-a.myshopify.com');
  assert.deepEqual((rpc.p_payload as Row).line_items, [{ id: 901, quantity: 40 }]);
  assert.equal((rpc.p_payload as Row)._atlas_connection, undefined);
});
test('invalid HMAC and wrong connection perform no database writes', async () => {
  assert.equal((await handleFulfillmentWebhook(JSON.stringify(payload), { 'x-shopify-hmac-sha256': 'invalid' })).status, 401);
  assert.equal((await deliver(payload, 'other.myshopify.com')).status, 401);
  assert.equal(requests.length, 0);
});
test('non-object signed payload is rejected before persistence', async () => {
  assert.equal((await deliver([])).status, 400);
  assert.equal(requests.length, 0);
});
test('webhook-before-order stays durable, then automatic replay uses the stored binding', async () => {
  projectionError = 'Shopify order not yet synced: 900';
  const first = await deliver();
  assert.equal(first.status, 500); assert.equal(events.length, 1);
  assert.equal(states.get(first.eventId!)?.state, 'failed');
  projectionError = null;
  assert.deepEqual(await replay(), { scanned: 1, projected: 1, failed: 0, dead: 0 });
  assert.equal(states.get(first.eventId!)?.state, 'projected');
  assert.deepEqual(rpcBodies()[0], rpcBodies()[1]);
});
test('redelivery retries a failed durable event without a new event identity', async () => {
  projectionError = 'Shopify order line not yet synced: 901';
  const first = await deliver(); projectionError = null;
  const retry = await deliver();
  assert.equal(retry.status, 200); assert.equal(retry.eventId, first.eventId); assert.equal(events.length, 1);
  const dedup = requests.find((r) => r.path === '/rest/v1/event_log' && r.method === 'GET')!;
  assert.equal(dedup.query.get('org_id'), `eq.${orgA}`);
});
test('same IDs/payload in two business connections get different durable event keys', async () => {
  await deliver();
  process.env.ATLAS_ORG_ID = orgB; process.env.SHOPIFY_SHOP_DOMAIN = 'fixture-b.myshopify.com';
  await deliver(payload, 'fixture-b.myshopify.com');
  assert.equal(events.length, 2);
  assert.notEqual(events[0]!.idempotency_key, events[1]!.idempotency_key);
  assert.equal(rpcBodies()[1]!.p_org_id, orgB);
});
test('contradictory content at one source revision is delivered to SQL conflict detection', async () => {
  await deliver(); await deliver({ ...payload, line_items: [{ id: 901, quantity: 41 }] });
  assert.equal(events.length, 2); assert.equal(rpcBodies().length, 2);
});
test('replay refuses changed deployment context and unbound legacy events', async () => {
  await deliver();
  const event = toAppendedEvent(events[0]!);
  const count = rpcBodies().length;
  process.env.ATLAS_ORG_ID = orgB;
  await assert.rejects(projectFulfillment(event), /does not match/);
  process.env.ATLAS_ORG_ID = orgA; process.env.SHOPIFY_SHOP_DOMAIN = 'other.myshopify.com';
  await assert.rejects(projectFulfillment(event), /does not match/);
  await assert.rejects(projectFulfillment({ ...event, payload }), /no verified connection/);
  assert.equal(rpcBodies().length, count);
});
test('malformed/unversioned SQL projection errors remain visible and retryable', async () => {
  projectionError = 'Shopify fulfillment updated_at with timezone is required';
  assert.equal((await deliver({ ...payload, updated_at: null })).status, 500);
  assert.match(String([...states.values()][0]!.last_error), /updated_at/);
});
test('unsafe numeric source IDs fail before any lossy mapping is persisted', async () => {
  await assert.rejects(projectShopifyDispatch(configuredShopifyDispatchContext(), { ...payload, id: 9007199254740992 }), /safe integers/);
  assert.equal(rpcBodies().length, 0);
});
test('bulk sync uses the same projection RPC as webhook ingestion', async () => {
  orders = [{ id: 900, currency: 'NZD', line_items: [{ id: 901, sku: 'SKU', quantity: 100, price: '1.00' }],
    fulfillments: [payload] }];
  assert.equal(await syncOrders(), 1);
  const bulk = rpcBodies()[0]; await deliver();
  assert.deepEqual(bulk, rpcBodies()[1]);
  assert.equal(requests.filter((r) => r.method === 'POST' && r.path === '/rest/v1/shopify_fulfillments').length, 0);
});
test('embedded fulfillment cannot borrow another order identity', async () => {
  orders = [{ id: 900, currency: 'NZD', fulfillments: [{ ...payload, order_id: 999 }] }];
  await assert.rejects(syncOrders(), /different order/);
  assert.equal(rpcBodies().length, 0);
  assert.equal(requests.some((r) => r.path === '/rest/v1/shopify_orders'), false);
});
test('a changed shop binding blocks sync before any canonical source writes', async () => {
  bindingError = true;
  await assert.rejects(syncOrders(), { message: 'Shopify connection binding mismatch' });
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.path, '/rest/v1/rpc/bind_shopify_dispatch_source');
});
test('generic read scopes both header and lines and hides another business/source', async () => {
  assert.equal((await readDispatch({ orgId: orgA, sourceId: source }, dispatch))?.lines[0]?.quantity, 40);
  assert.equal(requests.length, 1, 'one consistent header/lines read');
  const lineRead = requests[0]!;
  assert.equal(lineRead.query.get('org_id'), `eq.${orgA}`); assert.equal(lineRead.query.get('source_id'), `eq.${source}`);
  assert.equal(lineRead.query.get('lines.active'), 'eq.true');
  assert.equal(await readDispatch({ orgId: orgB, sourceId: source }, dispatch), null);
  assert.equal(await readDispatch({ orgId: orgA, sourceId: 'different' }, dispatch), null);
});
test('normalized dispatch cannot fall through to whole-order legacy invoicing', async () => {
  await assert.rejects(draftInvoice({ fulfillmentEventId: 'event' }, { agentName: 'controller' }), /dispatch allocation required/);
  assert.equal(requests.some((r) => r.path === '/rest/v1/shopify_order_lines' || r.path.includes('/rpc/draft_invoice')), false);
});
