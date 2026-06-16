// Pure policy-engine unit tests. Zero chain calls; runs under `node --test --import tsx`.

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluate,
  hbarToTinybar,
  tinybarToHbar,
  type ConversionEvent,
  type Payment,
  type PaymentRecord,
  type PolicyState,
  type RuleConfig,
} from '../src/policy/index.js';

const NOW = Date.parse('2026-06-15T12:00:00Z');

function payment(overrides: Partial<Payment> = {}): Payment {
  return {
    recipient: '0.0.4001',
    creatorCode: 'ABC',
    orderId: 'order-1042',
    amount: hbarToTinybar('10'),
    currency: 'HBAR',
    ...overrides,
  };
}

function conversion(overrides: Partial<ConversionEvent> = {}): ConversionEvent {
  return {
    type: 'conversion',
    creatorCode: 'ABC',
    orderId: 'order-1042',
    orderValue: hbarToTinybar('100'),
    commission: hbarToTinybar('10'),
    verifiedAt: new Date(NOW - 3_600_000).toISOString(),
    status: 'verified',
    ...overrides,
  };
}

function state(overrides: Partial<PolicyState> = {}): PolicyState {
  return {
    recentPayments: [],
    paidOrderIds: new Set(),
    verifiedConversions: [conversion()],
    now: NOW,
    ...overrides,
  };
}

const DEFAULT_CONFIG: RuleConfig = {
  currency: 'HBAR',
  perTransactionCap: { amount: hbarToTinybar('100') },
  rollingWindow: { amount: hbarToTinybar('500'), windowHours: 168 },
  velocityLimit: { maxPayments: 20, windowHours: 168 },
  allowlist: { entries: ['creator-code:ABC', 'creator-code:DEF'] },
  approvalThreshold: { amount: hbarToTinybar('50') },
  conditionalGate: {
    requireVerifiedConversion: true,
    maxCommissionRate: 0.2,
    amountTolerance: 0n,
  },
  idempotency: { enabled: true },
};

// ---------- tinybar conversion ----------

test('hbarToTinybar — whole numbers', () => {
  assert.equal(hbarToTinybar('1'), 100_000_000n);
  assert.equal(hbarToTinybar('100'), 10_000_000_000n);
});

test('hbarToTinybar — fractional precision', () => {
  assert.equal(hbarToTinybar('0.5'), 50_000_000n);
  assert.equal(hbarToTinybar('1.23456789'), 123_456_789n);
});

test('hbarToTinybar — rejects malformed input', () => {
  assert.throws(() => hbarToTinybar('1.234567890'));   // > 8 decimals
  assert.throws(() => hbarToTinybar('abc'));
  assert.throws(() => hbarToTinybar(''));
});

test('tinybarToHbar — round-trip', () => {
  for (const input of ['0', '1', '12.5', '0.00000001', '123456.789']) {
    assert.equal(tinybarToHbar(hbarToTinybar(input)), input);
  }
});

// ---------- happy path ----------

test('evaluate — happy path: verified conversion, all rules pass → allow', () => {
  const d = evaluate(payment(), state(), DEFAULT_CONFIG);
  assert.equal(d.decision, 'allow');
  assert.deepEqual(d.reasons, ['all configured rules cleared']);
});

// ---------- perTransactionCap ----------

test('perTransactionCap — over cap → block', () => {
  const d = evaluate(
    payment({ amount: hbarToTinybar('150') }),
    state({ verifiedConversions: [conversion({ commission: hbarToTinybar('150') })] }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('perTransactionCap')));
});

// ---------- rollingWindow ----------

test('rollingWindow — sum within window would breach → block', () => {
  const recent: PaymentRecord[] = [
    {
      payment: payment({ orderId: 'p-1', amount: hbarToTinybar('490') }),
      occurredAt: NOW - 24 * 3_600_000,
      txId: '0.0.x@1',
      decision: 'allow',
    },
  ];
  const d = evaluate(
    payment({ amount: hbarToTinybar('20') }),
    state({ recentPayments: recent }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('rollingWindow')));
});

test('rollingWindow — old payments (outside window) do not count', () => {
  const recent: PaymentRecord[] = [
    {
      payment: payment({ orderId: 'p-old', amount: hbarToTinybar('490') }),
      occurredAt: NOW - 200 * 3_600_000,                   // 200h ago → outside 168h
      txId: '0.0.x@old',
      decision: 'allow',
    },
  ];
  const d = evaluate(
    payment({ amount: hbarToTinybar('10') }),
    state({ recentPayments: recent }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'allow');
});

// ---------- velocityLimit ----------

test('velocityLimit — adding one more would breach → block', () => {
  const recent: PaymentRecord[] = [];
  for (let i = 0; i < 20; i++) {
    recent.push({
      payment: payment({ orderId: `p-${i}`, amount: 1n }),
      occurredAt: NOW - (i + 1) * 3_600_000,
      txId: `0.0.x@${i}`,
      decision: 'allow',
    });
  }
  const d = evaluate(payment(), state({ recentPayments: recent }), DEFAULT_CONFIG);
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('velocityLimit')));
});

// ---------- allowlist / denylist ----------

test('allowlist — recipient creator code allowed → allow', () => {
  const d = evaluate(payment({ creatorCode: 'ABC' }), state(), DEFAULT_CONFIG);
  assert.equal(d.decision, 'allow');
});

test('allowlist — creator code missing → block', () => {
  const d = evaluate(
    payment({ creatorCode: 'XYZ' }),
    state({ verifiedConversions: [conversion({ creatorCode: 'XYZ' })] }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('allowlist')));
});

test('denylist — present → block', () => {
  const cfg: RuleConfig = {
    ...DEFAULT_CONFIG,
    denylist: { entries: ['creator-code:ABC'] },
  };
  const d = evaluate(payment(), state(), cfg);
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('denylist')));
});

// ---------- approvalThreshold ----------

test('approvalThreshold — over threshold but under cap → escalate', () => {
  const d = evaluate(
    payment({ amount: hbarToTinybar('75') }),
    state({
      // orderValue large enough that 75/orderValue stays at or below the 20% cap
      verifiedConversions: [conversion({ commission: hbarToTinybar('75'), orderValue: hbarToTinybar('500') })],
    }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'escalate');
  assert.ok(d.reasons.some((r) => r.includes('approvalThreshold')));
});

test('approvalThreshold — escalate is overridden by block from another rule', () => {
  // 60 HBAR is above the 50 threshold AND not allowlisted → block must win over escalate.
  const d = evaluate(
    payment({ amount: hbarToTinybar('60'), creatorCode: 'ZZZ' }),
    state({ verifiedConversions: [conversion({ creatorCode: 'ZZZ', commission: hbarToTinybar('60') })] }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'block');
});

// ---------- conditionalGate ----------

test('conditionalGate — no matching conversion → block', () => {
  const d = evaluate(payment(), state({ verifiedConversions: [] }), DEFAULT_CONFIG);
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('conditionalGate')));
});

test('conditionalGate — amount mismatch beyond tolerance → block', () => {
  const d = evaluate(
    payment({ amount: hbarToTinybar('20') }),
    state({ verifiedConversions: [conversion({ commission: hbarToTinybar('10') })] }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('conditionalGate')));
});

test('conditionalGate — commission rate above maxCommissionRate → block', () => {
  const d = evaluate(
    payment({ amount: hbarToTinybar('30') }),
    state({
      verifiedConversions: [
        conversion({ commission: hbarToTinybar('30'), orderValue: hbarToTinybar('100') }), // 30% > 20%
      ],
    }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('conditionalGate')));
});

// ---------- idempotency ----------

test('idempotency — already-paid orderId → block', () => {
  const d = evaluate(
    payment(),
    state({ paidOrderIds: new Set(['order-1042']) }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'block');
  assert.ok(d.reasons.some((r) => r.includes('idempotency')));
});

test('idempotency — disabled → does not block', () => {
  const cfg: RuleConfig = { ...DEFAULT_CONFIG, idempotency: { enabled: false } };
  const d = evaluate(
    payment(),
    state({ paidOrderIds: new Set(['order-1042']) }),
    cfg,
  );
  assert.equal(d.decision, 'allow');
});

// ---------- aggregation precedence ----------

test('aggregation — block beats escalate beats allow', () => {
  // Block (idempotency) + Escalate (approvalThreshold) + Allow (everything else)
  const cfg: RuleConfig = { ...DEFAULT_CONFIG };
  const d = evaluate(
    payment({ amount: hbarToTinybar('75') }),
    state({
      paidOrderIds: new Set(['order-1042']),
      verifiedConversions: [conversion({ commission: hbarToTinybar('75') })],
    }),
    cfg,
  );
  assert.equal(d.decision, 'block');
  // Block reasons should include idempotency; escalate reasons should NOT appear in the
  // block payload (since block won).
  assert.ok(d.reasons.some((r) => r.includes('idempotency')));
  assert.ok(d.reasons.every((r) => !r.includes('approvalThreshold')));
});

test('aggregation — escalate alone surfaces all escalate reasons', () => {
  const d = evaluate(
    payment({ amount: hbarToTinybar('75') }),
    state({
      verifiedConversions: [conversion({ commission: hbarToTinybar('75'), orderValue: hbarToTinybar('500') })],
    }),
    DEFAULT_CONFIG,
  );
  assert.equal(d.decision, 'escalate');
  assert.ok(d.reasons.some((r) => r.includes('approvalThreshold')));
});

test('empty config — no rules configured → allow with informative reason', () => {
  // Idempotency defaults to ON; switch it off to exercise the empty-config path.
  const d = evaluate(payment(), state(), { currency: 'HBAR', idempotency: { enabled: false } });
  assert.equal(d.decision, 'allow');
  assert.deepEqual(d.reasons, ['no rules configured; default-allow']);
});
