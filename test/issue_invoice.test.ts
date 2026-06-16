// Tests for controller.issue_invoice — covers the pure extractor and the wired path
// from extractor → evaluate() for allow / escalate / block. The DB handler is covered
// by the live-Supabase verification suite (deferred, same convention as routing.test.ts).

import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildPolicyInput, type IssueInvoiceInput } from '../src/agents/controller/tools/issue_invoice.js';
import { evaluate, toMinor, type PolicyInput, type RuleConfig } from '../src/platform/policy/index.js';

const CTX = { agentName: 'controller', subjectType: 'invoice', subjectId: 'inv-1' };
const NOW = Date.parse('2026-06-16T12:00:00Z');

function sampleInput(overrides: Partial<IssueInvoiceInput> = {}): IssueInvoiceInput {
  return {
    invoiceId: 'inv-1',
    amount: toMinor('250'),                                  // 250 NZD
    currency: 'NZD',
    accountId: 'acct-1',
    fulfillmentEventId: 'ful-1',
    ...overrides,
  };
}

// ---------- extractor shape ----------

test('buildPolicyInput maps tool input → PolicyInput attributes', () => {
  const partial = buildPolicyInput(sampleInput(), CTX);

  assert.equal(partial.subjectType, 'invoice');
  assert.equal(partial.subjectId, 'inv-1');
  assert.equal(partial.amount, toMinor('250'));
  assert.equal(partial.currency, 'NZD');
  assert.deepEqual(partial.attributes, {
    account_id: 'acct-1',
    fulfillment_event_id: 'ful-1',
  });
});

test('buildPolicyInput is pure — same input → same output', () => {
  const input = sampleInput();
  const a = buildPolicyInput(input, CTX);
  const b = buildPolicyInput(input, CTX);
  assert.deepEqual(a, b);
});

// ---------- end-to-end: extractor → evaluate() ----------

function makePolicyInput(input: IssueInvoiceInput): PolicyInput {
  return { action: 'controller.issue_invoice', ...buildPolicyInput(input, CTX) };
}

const ALLOW_CONFIG: RuleConfig = {
  perTransactionCap: { amount: toMinor('1000') },
  allowlist: { attribute: 'account_id', values: ['acct-1'] },
  approvalThreshold: { amount: toMinor('500') },
  idempotency: { enabled: true, attribute: 'fulfillment_event_id' },
};

test('extractor → evaluate → allow when under threshold and account allowlisted', () => {
  const decision = evaluate(
    makePolicyInput(sampleInput({ amount: toMinor('250') })),
    { recentActions: [], completedSubjectKeys: new Set(), preconditions: [], now: NOW },
    ALLOW_CONFIG,
  );
  assert.equal(decision.decision, 'allow');
});

test('extractor → evaluate → escalate when amount crosses approvalThreshold', () => {
  const decision = evaluate(
    makePolicyInput(sampleInput({ amount: toMinor('750') })),
    { recentActions: [], completedSubjectKeys: new Set(), preconditions: [], now: NOW },
    ALLOW_CONFIG,
  );
  assert.equal(decision.decision, 'escalate');
  assert.ok(decision.reasons.some((r) => r.includes('approvalThreshold')));
});

test('extractor → evaluate → block when amount exceeds perTransactionCap', () => {
  const decision = evaluate(
    makePolicyInput(sampleInput({ amount: toMinor('1500') })),
    { recentActions: [], completedSubjectKeys: new Set(), preconditions: [], now: NOW },
    ALLOW_CONFIG,
  );
  assert.equal(decision.decision, 'block');
  assert.ok(decision.reasons.some((r) => r.includes('perTransactionCap')));
});

test('extractor → evaluate → block by idempotency when fulfillment already invoiced', () => {
  const decision = evaluate(
    makePolicyInput(sampleInput()),
    {
      recentActions: [],
      completedSubjectKeys: new Set(['ful-1']),
      preconditions: [],
      now: NOW,
    },
    ALLOW_CONFIG,
  );
  assert.equal(decision.decision, 'block');
  assert.ok(decision.reasons.some((r) => r.includes('idempotency')));
});

test('extractor → evaluate → block when account is not on allowlist', () => {
  const decision = evaluate(
    makePolicyInput(sampleInput({ accountId: 'acct-unknown' })),
    { recentActions: [], completedSubjectKeys: new Set(), preconditions: [], now: NOW },
    ALLOW_CONFIG,
  );
  assert.equal(decision.decision, 'block');
  assert.ok(decision.reasons.some((r) => r.includes('allowlist')));
});
