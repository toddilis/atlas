import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  ActionV1, ActionTransitionV1, ControllerChainV1, ControllerEventV1,
  ExecutionV1, MoneyV1, actionIntentHash,
} from '../src/platform/contracts/controller-v1.js';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/architecture/controller-chain.json', import.meta.url), 'utf8'));
const invalidCases: { name: string; path: (string | number)[]; value: unknown }[] =
  JSON.parse(readFileSync(new URL('./fixtures/architecture/invalid-cases.json', import.meta.url), 'utf8'));
const clone = () => structuredClone(fixture);

test('reference Controller chain preserves exact money and an explicitly unknown outcome', () => {
  const chain = ControllerChainV1.parse(fixture);
  assert.equal(chain.action.parameters.total.amount_minor, '9007199254740993');
  assert.equal(actionIntentHash(chain.action), chain.approval.action_intent_hash);
  assert.equal(chain.outcome?.status, 'unknown');
  assert.equal(chain.outcome?.metrics_after.length, 0);
});

for (const invalid of invalidCases) {
  test(`reference contract rejects ${invalid.name}`, () => {
    const value = clone();
    let target = value;
    for (const segment of invalid.path.slice(0, -1)) target = target[segment];
    target[invalid.path.at(-1)!] = invalid.value;
    assert.equal(ControllerChainV1.safeParse(value).success, false);
  });
}

test('fingerprint is stable across key order and execution progress, but binds destination and policy', () => {
  const action = ActionV1.parse(fixture.action);
  const reversed = Object.fromEntries(Object.entries(action).reverse());
  assert.equal(actionIntentHash(ActionV1.parse(reversed)), actionIntentHash(action));
  assert.equal(actionIntentHash({ ...action, execution_state: 'EXECUTING' }), actionIntentHash(action));
  assert.notEqual(actionIntentHash({ ...action, target: { ...action.target, account_id: 'another-account' } }), actionIntentHash(action));
  assert.notEqual(actionIntentHash({ ...action, policy_snapshot_ref: { ...action.policy_snapshot_ref, revision: 2 } }), actionIntentHash(action));
});

test('numeric money and undocumented fields fail closed at reference boundary', () => {
  assert.equal(MoneyV1.safeParse({ amount_minor: 1, currency: 'NZD', scale: 2 }).success, false);
  assert.equal(MoneyV1.safeParse({ amount_minor: '1.5', currency: 'NZD', scale: 2 }).success, false);
  assert.equal(ActionV1.safeParse({ ...fixture.action, bypass_policy: true }).success, false);
});

test('linkage rejects cross-business evidence and duplicate attempt identities', () => {
  const foreign = clone();
  foreign.executions[0].evidence_refs[0].company_id = 'foreign-business';
  assert.equal(ControllerChainV1.safeParse(foreign).success, false);
  const duplicate = clone();
  duplicate.executions.push(structuredClone(duplicate.executions[0]));
  assert.equal(ControllerChainV1.safeParse(duplicate).success, false);
});

test('uncertain attempts require reconciliation ownership and cannot directly execute again', () => {
  const uncertain = { ...fixture.executions[0], state: 'UNRESOLVED', result: 'unknown', finished_at: null, evidence_refs: [] };
  assert.equal(ExecutionV1.safeParse(uncertain).success, false);
  assert.equal(ExecutionV1.safeParse({ ...uncertain, reconciliation_owner: 'operator-1' }).success, true);
  assert.equal(ActionTransitionV1.safeParse({ from: 'UNRESOLVED', to: 'EXECUTING' }).success, false);
  assert.equal(ActionTransitionV1.safeParse({ from: 'RECONCILIATION_REQUIRED', to: 'CONFIRMED' }).success, true);
  assert.equal(ActionTransitionV1.safeParse({ from: 'FAILED', to: 'AUTHORISED' }).success, true);
  assert.equal(ActionTransitionV1.safeParse({ from: 'CONFIRMED', to: 'EXECUTING' }).success, false);
});

test('email needs an explicit recipient/connection and its own confirmation evidence', () => {
  const chain = clone();
  chain.action.parameters.channel = 'email';
  assert.equal(ActionV1.safeParse(chain.action).success, false);
  chain.action.parameters.recipient = 'fixture@example.invalid';
  chain.action.target.connection_id = 'fixture-mail';
  chain.approval.action_intent_hash = actionIntentHash(chain.action);
  chain.executions[0].connection_id = 'fixture-mail';
  assert.equal(ControllerChainV1.safeParse(chain).success, false);
  chain.executions[0].result = 'delivery_confirmed';
  chain.executions[0].provider_reference = 'fixture-delivery';
  assert.equal(ControllerChainV1.safeParse(chain).success, true);
});

test('registered events reject unknown versions, wrong payloads and proposals labelled as facts', () => {
  const event = {
    event_id: 'event-1', event_type: 'controller.decision.proposed', event_version: 1,
    company_id: fixture.decision.company_id, connection_id: null,
    occurred_at: fixture.decision.created_at, observed_at: fixture.decision.created_at,
    producer: 'fixture-controller', subject_type: 'Decision', subject_id: fixture.decision.decision_id,
    subject_version: 1, correlation_id: 'journey-1', causation_id: null,
    source_refs: [], evidence_refs: fixture.observation.evidence_refs,
    event_class: 'proposal', payload: fixture.decision,
  };
  assert.equal(ControllerEventV1.safeParse(event).success, true);
  for (const change of [
    { event_version: 2 }, { event_type: 'unknown' }, { payload: {} },
    { company_id: 'other' }, { event_class: 'fact' },
    { event_type: 'toString' }, { event_type: '__proto__' },
    { subject_id: 'wrong-decision' }, { subject_version: 2 },
    { evidence_refs: [{ company_id: 'other', type: 'Evidence', id: 'foreign' }] },
  ]) assert.equal(ControllerEventV1.safeParse({ ...event, ...change }).success, false);
});
