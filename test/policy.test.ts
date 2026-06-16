// Pure policy-engine unit tests. Zero chain / DB calls; runs under
// `node --test --import tsx`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluate,
  toMajor,
  toMinor,
  type ActionRecord,
  type PolicyInput,
  type PolicyState,
  type Precondition,
  type RuleConfig,
} from '../src/platform/policy/index.js';

const NOW = Date.parse('2026-06-16T12:00:00Z');

function input(overrides: Partial<PolicyInput> = {}): PolicyInput {
  return {
    action: 'controller.issue_invoice',
    subjectType: 'invoice',
    subjectId: 'inv-1',
    amount: toMinor('100'),                      // 100 NZD = 10000 cents
    currency: 'NZD',
    attributes: {
      account_id: 'acct-1',
      fulfillment_event_id: 'ful-1',
    },
    ...overrides,
  };
}

function precondition(overrides: Partial<Precondition> = {}): Precondition {
  return {
    kind: 'wholesale_fulfillment',
    key: 'ful-1',
    amount: toMinor('100'),
    currency: 'NZD',
    attributes: { account_id: 'acct-1' },
    verifiedAt: NOW - 3_600_000,
    ...overrides,
  };
}

function state(overrides: Partial<PolicyState> = {}): PolicyState {
  return {
    recentActions: [],
    completedSubjectKeys: new Set(),
    preconditions: [precondition()],
    now: NOW,
    ...overrides,
  };
}

const DEFAULT_CONFIG: RuleConfig = {
  perTransactionCap: { amount: toMinor('1000') },        // 1000 NZD
  rollingWindow: { amount: toMinor('5000'), windowHours: 168 },
  velocityLimit: { maxActions: 20, windowHours: 168 },
  allowlist: { attribute: 'account_id', values: ['acct-1', 'acct-2'] },
  approvalThreshold: { amount: toMinor('500') },
  conditionalGate: {
    requirePrecondition: true,
    precondition: 'wholesale_fulfillment',
    matchAttribute: 'fulfillment_event_id',
    amountTolerance: 0n,
  },
  idempotency: { enabled: true, attribute: 'fulfillment_event_id' },
};

// ---------- amount helpers ----------

test('toMinor — whole numbers', () => {
  assert.equal(toMinor('1'), 100n);
  assert.equal(toMinor('100'), 10_000n);
});

test('toMinor — fractional precision (default 100 minor/major)', () => {
  assert.equal(toMinor('0.5'), 50n);
  assert.equal(toMinor('1.23'), 123n);
  assert.equal(toMinor('0.01'), 1n);
});

test('toMinor — rejects malformed input', () => {
  assert.throws(() => toMinor('1.234'));   // > 2 decimals
  assert.throws(() => toMinor('abc'));
  assert.throws(() => toMinor(''));
});

test('toMajor — round-trip', () => {
  for (const input of ['0', '1', '12.5', '0.01', '123456.78']) {
    assert.equal(toMajor(toMinor(input)), input);
  }
});

// ---------- happy path ----------

test('evaluate — happy path: matching precondition, all rules pass → allow', () => {
  const d = evaluate(input(), state(), DEFAULT_CONFIG);
  assert.equal(d.decision, 'allow');
  assert.deepEqual(d.reasons, ['all configured rules cleared']);
});

// ---------- perTransactionCap ----------

test('perTransactionCap — over cap → block', () => {
  const d = evaluate(
    input({ amount: toMinor('1500') }),
    state({ preconditions: [precondition({ amount: toMinor('1500') })] }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('perTransactionCap')));
});

// ---------- rollingWindow ----------

test('rollingWindow — sum within window would breach → block', () => {
  const recent: ActionRecord[] = [
    {
      action: 'controller.issue_invoice',
      subjectType: 'invoice',
      subjectId: 'inv-prev',
      amount: toMinor('4950'),
      currency: 'NZD',
      attributes: {},
      occurredAt: NOW - 24 * 3_600_000,
      txRef: null,
      decision: 'allow',
    },
  ];
  const d = evaluate(
    input({ amount: toMinor('100') }),
    state({ recentActions: recent }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('rollingWindow')));
});

test('rollingWindow — old actions (outside window) do not count', () => {
  const recent: ActionRecord[] = [
    {
      action: 'controller.issue_invoice',
      subjectType: 'invoice',
      subjectId: 'inv-old',
      amount: toMinor('4950'),
      currency: 'NZD',
      attributes: {},
      occurredAt: NOW - 200 * 3_600_000,             // 200h ago → outside 168h
      txRef: null,
      decision: 'allow',
    },
  ];
  const d = evaluate(input(), state({ recentActions: recent }), DEFAULT_CONFIG);
  assert.equal(d.decision, 'allow');
});

test('rollingWindow — different currency does not count', () => {
  const recent: ActionRecord[] = [
    {
      action: 'controller.issue_invoice',
      subjectType: 'invoice',
      subjectId: 'inv-usd',
      amount: toMinor('4950'),
      currency: 'USD',
      attributes: {},
      occurredAt: NOW - 24 * 3_600_000,
      txRef: null,
      decision: 'allow',
    },
  ];
  const d = evaluate(input(), state({ recentActions: recent }), DEFAULT_CONFIG);
  assert.equal(d.decision, 'allow');
});

// ---------- velocityLimit ----------

test('velocityLimit — adding one more would breach → block', () => {
  const recent: ActionRecord[] = [];
  for (let i = 0; i < 20; i++) {
    recent.push({
      action: 'controller.issue_invoice',
      subjectType: 'invoice',
      subjectId: `inv-${i}`,
      amount: 1n,
      currency: 'NZD',
      attributes: {},
      occurredAt: NOW - (i + 1) * 3_600_000,
      txRef: null,
      decision: 'allow',
    });
  }
  const d = evaluate(input(), state({ recentActions: recent }), DEFAULT_CONFIG);
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('velocityLimit')));
});

// ---------- allowlist / denylist ----------

test('allowlist — account_id is on the list → allow', () => {
  const d = evaluate(input(), state(), DEFAULT_CONFIG);
  assert.equal(d.decision, 'allow');
});

test('allowlist — account_id missing from list → block', () => {
  const d = evaluate(
    input({ attributes: { account_id: 'acct-xyz', fulfillment_event_id: 'ful-1' } }),
    state({ preconditions: [precondition({ attributes: { account_id: 'acct-xyz' } })] }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('allowlist')));
});

test('denylist — value matches → block', () => {
  const cfg: RuleConfig = {
    ...DEFAULT_CONFIG,
    denylist: { attribute: 'account_id', values: ['acct-1'] },
  };
  const d = evaluate(input(), state(), cfg);
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('denylist')));
});

// ---------- approvalThreshold ----------

test('approvalThreshold — over threshold but under cap → escalate', () => {
  const d = evaluate(
    input({ amount: toMinor('750') }),
    state({ preconditions: [precondition({ amount: toMinor('750') })] }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'escalate');
  assert.ok(d.reasons.some((r) => r.includes('approvalThreshold')));
});

test('approvalThreshold — escalate overridden by block from another rule', () => {
  // 600 NZD is above threshold AND account is not on allowlist → block wins.
  const d = evaluate(
    input({
      amount: toMinor('600'),
      attributes: { account_id: 'acct-xyz', fulfillment_event_id: 'ful-1' },
    }),
    state({
      preconditions: [
        precondition({ amount: toMinor('600'), attributes: { account_id: 'acct-xyz' } }),
      ],
    }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'block');
});

// ---------- conditionalGate ----------

test('conditionalGate — no matching precondition → block', () => {
  const d = evaluate(input(), state({ preconditions: [] }), DEFAULT_CONFIG);
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('conditionalGate')));
});

test('conditionalGate — amount mismatch beyond tolerance → block', () => {
  const d = evaluate(
    input({ amount: toMinor('200') }),
    state({ preconditions: [precondition({ amount: toMinor('100') })] }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('conditionalGate')));
});

test('conditionalGate — currency mismatch → block', () => {
  const d = evaluate(
    input({ currency: 'USD' }),
    state({ preconditions: [precondition({ currency: 'NZD' })] }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('conditionalGate')));
});

test('conditionalGate — within tolerance → allow', () => {
  const cfg: RuleConfig = {
    ...DEFAULT_CONFIG,
    conditionalGate: {
      requirePrecondition: true,
      precondition: 'wholesale_fulfillment',
      matchAttribute: 'fulfillment_event_id',
      amountTolerance: toMinor('1'),                 // 1 NZD tolerance
    },
  };
  const d = evaluate(
    input({ amount: toMinor('100.50') }),
    state({ preconditions: [precondition({ amount: toMinor('100') })] }),
    cfg,
  );
  assert.equal(d.decision, 'allow');
});

// ---------- idempotency ----------

test('idempotency — already-completed key → block', () => {
  const d = evaluate(
    input(),
    state({ completedSubjectKeys: new Set(['ful-1']) }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('idempotency')));
});

test('idempotency — disabled → does not block', () => {
  const cfg: RuleConfig = {
    ...DEFAULT_CONFIG,
    idempotency: { enabled: false, attribute: 'fulfillment_event_id' },
  };
  const d = evaluate(
    input(),
    state({ completedSubjectKeys: new Set(['ful-1']) }),
    cfg,
  );
  assert.equal(d.decision, 'allow');
});

// ---------- aggregation precedence ----------

test('aggregation — block beats escalate beats allow', () => {
  const d = evaluate(
    input({ amount: toMinor('750') }),                                  // escalate
    state({
      completedSubjectKeys: new Set(['ful-1']),                          // block (idempotency)
      preconditions: [precondition({ amount: toMinor('750') })],
    }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('idempotency')));
  assert.ok(d.reasons.every((r) => !r.includes('approvalThreshold')));
});

test('aggregation — escalate alone surfaces all escalate reasons', () => {
  const d = evaluate(
    input({ amount: toMinor('750') }),
    state({ preconditions: [precondition({ amount: toMinor('750') })] }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'escalate');
  assert.ok(d.reasons.some((r) => r.includes('approvalThreshold')));
});

test('empty config — no rules configured → allow with informative reason', () => {
  const d = evaluate(input(), state(), {});
  assert.equal(d.decision, 'allow');
  assert.deepEqual(d.reasons, ['no rules configured; default-allow']);
});
