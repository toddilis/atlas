import assert from 'node:assert/strict';
import test from 'node:test';
import { askAssistant, assistantOutcomeFor, isAssistantOutcome, ASSISTANT_OUTCOMES, MAX_MODEL_CALLS, type AssistantTurn } from '../lib/assistant';
import type { ToolRun } from '../lib/assistant-tools';

const turn = (extra: Partial<AssistantTurn>): AssistantTurn => ({ stopReason: 'end_turn', model: 'test-model', text: '', toolUses: [], ...extra });
const run = (rows: number[]): ToolRun => ({
  citation: { tool: 'invoices_lookup', args: { overdue_only: true }, rows: rows.map(n => ({ kind: 'invoice', id: `inv-${n}`, label: `invoice #${n}` })) },
  result: rows.map(n => ({ invoice_number: `#${n}`, total: `${n}.00 NZD`, state: 'issued' })),
});

test('the assistant answers from the tools it ran, and the citations are what actually ran', async () => {
  const calls: number[] = [];
  const result = await askAssistant('Which invoices are overdue?', {
    call: async (_q, transcript) => {
      calls.push(transcript.length);
      if (transcript.length === 0) return turn({ stopReason: 'tool_use', toolUses: [{ id: 't1', name: 'invoices_lookup', input: { overdue_only: true } }] });
      return turn({ text: 'Two invoices are overdue: #5002 for 5002.00 NZD and #88 for 88.00 NZD.' });
    },
    execute: async (name, args) => {
      assert.equal(name, 'invoices_lookup');
      assert.deepEqual(args, { overdue_only: true });
      return run([5002, 88]);
    },
  });
  assert.match(result.answer, /#5002/);
  assert.equal(result.citations.length, 1);
  assert.equal(result.citations[0]!.rows[0]!.id, 'inv-5002');
  assert.equal(result.model, 'test-model');
  assert.deepEqual(calls, [0, 2]);
});

test('an answer with a figure the queried rows do not carry is rejected', async () => {
  await assert.rejects(askAssistant('How much is overdue?', {
    call: async (_q, transcript) => transcript.length === 0
      ? turn({ stopReason: 'tool_use', toolUses: [{ id: 't1', name: 'invoices_lookup', input: {} }] })
      : turn({ text: 'Roughly 9999.00 NZD is overdue.' }),
    execute: async () => run([5002]),
  }), /introduces the number 9999/);
});

test('the question\'s own numbers are allowed; refusals, silence and runaway loops are failures', async () => {
  const quiet = await askAssistant('Is invoice 77 paid?', {
    call: async () => turn({ text: 'The records the tools can see do not include an invoice 77.' }),
    execute: async () => { throw new Error('never called'); },
  });
  assert.match(quiet.answer, /invoice 77/);
  assert.deepEqual(quiet.citations, []);

  await assert.rejects(askAssistant('q', { call: async () => turn({ stopReason: 'refusal' }), execute: async () => run([]) }), /model declined/);
  await assert.rejects(askAssistant('q', { call: async () => turn({ stopReason: 'max_tokens', text: 'truncat' }), execute: async () => run([]) }), /stopped early/);
  let callCount = 0;
  await assert.rejects(askAssistant('q', {
    call: async () => { callCount++; return turn({ stopReason: 'tool_use', toolUses: [{ id: `t${callCount}`, name: 'jobs_lookup', input: {} }] }); },
    execute: async () => run([]),
  }), /allowed number of model calls/);
  assert.equal(callCount, MAX_MODEL_CALLS);
});

test('failures map to fixed outcomes, never raw text', () => {
  assert.equal(assistantOutcomeFor('assistant answer rejected: it introduces the number 7, which is not in the records it was shown'), 'failed_grounding');
  assert.equal(assistantOutcomeFor('assistant failed: the model declined this question'), 'declined');
  assert.equal(assistantOutcomeFor('business actions paused'), 'paused');
  assert.equal(assistantOutcomeFor('tool entitlement missing or revoked'), 'not_allowed');
  assert.equal(assistantOutcomeFor('asking the assistant cannot itself require an approval; its grant must not require approval'), 'not_allowed');
  assert.equal(assistantOutcomeFor('socket hang up'), 'failed');
  for (const key of Object.keys(ASSISTANT_OUTCOMES)) assert.equal(isAssistantOutcome(key), true, key);
  assert.equal(isAssistantOutcome('x'), false);
});
