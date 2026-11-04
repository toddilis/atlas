import assert from 'node:assert/strict';
import test from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  ago, businessSteps, deploymentSteps, OFF_UNTIL_TURNED_ON, SEEDED_AT_BOOT, switchOnSql, switchRows,
  type GrantRow, type SetupSnapshot, type SetupStep,
} from '../lib/setup';

const now = new Date('2026-11-03T09:00:00Z');
const at = (minutes: number) => new Date(now.getTime() + minutes * 60_000).toISOString();
const seeded: GrantRow[] = SEEDED_AT_BOOT.map(tool_name => ({ agent_name: 'operator', tool_name, enabled: true }));
const dayOne: GrantRow[] = OFF_UNTIL_TURNED_ON.filter(w => w.dayOne).map(w => ({ agent_name: w.agent, tool_name: w.tool, enabled: true }));
const fresh: SetupSnapshot = {
  ledgerAccounts: 0, grants: [], paused: false, lastJobAt: null, waitingJobs: 0, profile: null,
  retailers: 0, products: 0, pricingActive: false, shopify: null, lastSyncAt: null, customers: { total: 0, linked: 0 },
  bankAccounts: 0, members: 0, invoices: { issued: 0, paid: 0 },
};
const ready: SetupSnapshot = {
  ledgerAccounts: 23, grants: [...seeded, ...dayOne], paused: false, lastJobAt: at(-5), waitingJobs: 0,
  profile: { legal_name: 'Synthetic Goods Ltd', payment_instructions: 'Pay to 12-3456-7890123-00' },
  retailers: 4, products: 12, pricingActive: true,
  shopify: { id: 'src', connection_key: 'synthetic.myshopify.com', enabled: true, sync_every_minutes: 15 }, lastSyncAt: at(-10),
  customers: { total: 40, linked: 4 }, bankAccounts: 1, members: 2, invoices: { issued: 3, paid: 1 },
};
const step = (steps: SetupStep[], key: string) => {
  const found = steps.find(s => s.key === key);
  assert.ok(found, `no step ${key}`);
  return found;
};

test('a fresh business has every required step to do, and bank accounts are optional', () => {
  const deploy = deploymentSteps(fresh, now), business = businessSteps(fresh, now);
  assert.deepEqual(deploy.map(s => s.key), ['chart', 'boot', 'switches', 'worker', 'pause']);
  // The first-day order the runbook gives.
  assert.deepEqual(business.map(s => s.key), ['profile', 'catalog', 'pricing', 'shopify', 'link', 'bank', 'members', 'first']);
  for (const key of ['chart', 'boot', 'switches', 'worker']) assert.equal(step(deploy, key).state, 'todo', key);
  assert.equal(step(deploy, 'pause').state, 'done');
  for (const s of business) assert.equal(s.state, s.key === 'bank' ? 'optional' : 'todo', s.key);
  assert.match(step(deploy, 'chart').detail, /seed_chart_of_accounts/);
  assert.match(step(deploy, 'boot').detail, /has not started with ATLAS_ORG_ID/);
  assert.match(step(deploy, 'switches').detail, /controller\.issue_invoice, payments\.record, members\.save/);
  assert.match(step(business, 'members').detail, /anyone on ATLAS_OPERATOR_EMAILS can sign in/);
});

test('a business ready for its first invoice is done everywhere', () => {
  for (const s of [...deploymentSteps(ready, now), ...businessSteps(ready, now)]) assert.equal(s.state, 'done', `${s.key}: ${s.detail}`);
  assert.equal(step(businessSteps(ready, now), 'shopify').detail, 'synthetic.myshopify.com, last synced 10 min ago.');
  assert.equal(step(businessSteps(ready, now), 'link').detail,
    '4 of 40 synced Shopify customers linked to retailers. Shipments for the other 36 are treated as retail orders and not invoiced.');
  assert.equal(step(businessSteps({ ...ready, customers: { total: 1, linked: 1 } }, now), 'link').detail, '1 of 1 synced Shopify customers linked to retailers.');
});

test('missing and revoked standard switches are told apart', () => {
  const missingTwo = { ...ready, grants: ready.grants.filter(g => g.tool_name !== 'bank.import' && g.tool_name !== 'reminders.void') };
  const boot = step(deploymentSteps(missingTwo, now), 'boot');
  assert.equal(boot.state, 'warn');
  assert.match(boot.detail, /^Missing bank\.import, reminders\.void: deploy the current API and worker/);
  const revoked = { ...ready, grants: ready.grants.map(g => g.tool_name === 'jobs.retry' ? { ...g, enabled: false } : g) };
  assert.match(step(deploymentSteps(revoked, now), 'boot').detail, /Turned off for this business: jobs\.retry\./);
  // A switch turned off is off, not on.
  const narrateOff = switchRows([{ agent_name: 'assistant', tool_name: 'assistant.narrate', enabled: false }]);
  assert.equal(narrateOff.find(w => w.tool === 'assistant.narrate')?.on, false);
  // A grant for another agent is not this switch.
  assert.equal(switchRows([{ agent_name: 'operator', tool_name: 'assistant.narrate', enabled: true }]).find(w => w.tool === 'assistant.narrate')?.on, false);
});

test('the worker step says why it is not done', () => {
  const worker = (s: Partial<SetupSnapshot>) => step(deploymentSteps({ ...ready, ...s }, now), 'worker');
  assert.match(worker({ waitingJobs: 3 }).detail, /^3 jobs have been due for over 10 minutes without being picked up/);
  assert.match(worker({ waitingJobs: 1 }).detail, /^1 job has been due/);
  assert.equal(worker({ paused: true, waitingJobs: 3 }).state, 'warn');
  assert.match(worker({ paused: true, waitingJobs: 3 }).detail, /paused, so the worker picks up no jobs/);
  assert.match(worker({ lastJobAt: null }).detail, /No job has run yet although Shopify is connected/);
  assert.equal(worker({ lastJobAt: null, shopify: null }).state, 'todo');
});

test('Shopify never synced, stale or turned off is a check, not done', () => {
  const shopify = (s: Partial<SetupSnapshot>) => step(businessSteps({ ...ready, ...s }, now), 'shopify');
  assert.equal(shopify({ lastSyncAt: null }).state, 'warn');
  assert.match(shopify({ lastSyncAt: null }).detail, /has never synced/);
  // Three cadences (45 minutes here) is the allowance the home page uses too.
  assert.equal(shopify({ lastSyncAt: at(-44) }).state, 'done');
  assert.match(shopify({ lastSyncAt: at(-46) }).detail, /last synced 46 min ago, later than its 15-minute cadence allows/);
  assert.match(shopify({ shopify: { ...ready.shopify!, enabled: false } }).detail, /is turned off, so nothing syncs/);
});

test('linking, the profile and the first invoice explain what is left', () => {
  const business = (s: Partial<SetupSnapshot>) => businessSteps({ ...ready, ...s }, now);
  const unlinked = step(business({ customers: { total: 40, linked: 0 } }), 'link');
  assert.equal(unlinked.state, 'todo');
  assert.match(unlinked.detail, /every shipment is treated as a retail order and nothing is invoiced/);
  const noInstructions = step(business({ profile: { legal_name: 'Synthetic Goods Ltd', payment_instructions: ' ' } }), 'profile');
  assert.equal(noInstructions.state, 'warn');
  assert.match(step(business({ invoices: { issued: 2, paid: 0 } }), 'first').detail, /^2 invoices issued; none has a payment recorded yet/);
  assert.match(step(business({ invoices: { issued: 0, paid: 0 } }), 'first').detail, /^Nothing issued yet/);
});

test('the SQL turns exactly one switch on for this business, with its tested risk', () => {
  const org = '11111111-1111-4111-8111-111111111111';
  assert.equal(switchOnSql(org, 'operator', 'controller.issue_invoice', 'approve_required'),
    "insert into tool_grants (org_id, agent_name, tool_name, risk, enabled)\n"
    + "values ('11111111-1111-4111-8111-111111111111', 'operator', 'controller.issue_invoice', 'approve_required', true)\n"
    + 'on conflict (org_id, agent_name, tool_name) do update set enabled = true;');
  assert.equal(OFF_UNTIL_TURNED_ON.find(w => w.tool === 'controller.issue_invoice')?.risk, 'approve_required');
  // None of the never-seeded switches is in the boot list, and the reverse.
  for (const w of OFF_UNTIL_TURNED_ON) assert.ok(!(SEEDED_AT_BOOT as readonly string[]).includes(w.tool), w.tool);
});

test('ages read plainly', () => {
  assert.equal(ago(at(0), now), 'under a minute ago');
  assert.equal(ago(at(-59), now), '59 min ago');
  assert.equal(ago(at(-150), now), '2 h ago');
  assert.equal(ago(at(-3 * 1440), now), '3 days ago');
});

test('the checklist knows exactly the switches the API and worker seed, and the never-seeded ones are real', () => {
  const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
  const boot = read('../../src/platform/orchestration/dispatch.ts');
  const seededOperator = [...boot.matchAll(/agentName: 'operator', toolName: '([^']+)'/g)].map(m => m[1]).sort();
  assert.deepEqual(seededOperator, [...SEEDED_AT_BOOT].sort());
  // Boot seeds no never-seeded switch under any agent.
  for (const w of OFF_UNTIL_TURNED_ON) assert.doesNotMatch(boot, new RegExp(`toolName: '${w.tool.replace('.', '\\.')}'`), w.tool);
  // Each never-seeded switch is one the database or worker actually checks.
  const migrations = readdirSync(fileURLToPath(new URL('../../supabase/migrations/', import.meta.url)))
    .filter(f => f.endsWith('.sql')).map(f => read(`../../supabase/migrations/${f}`)).join('\n');
  const worker = read('../../src/platform/jobs/daily-briefing.ts');
  for (const w of OFF_UNTIL_TURNED_ON) assert.ok(migrations.includes(`'${w.tool}'`) || worker.includes(`'${w.tool}'`), `${w.tool} is checked nowhere`);
});
