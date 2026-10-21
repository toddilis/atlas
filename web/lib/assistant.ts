// The assistant loop (AI-01, PR-T): read-only by contract. The model sees the question
// and the whitelisted tools; code executes every tool, builds the citations from what
// actually ran, and grounds the final answer — a digit run the queried rows do not carry
// (and the question itself did not carry) fails the exchange. No write tool exists.

import { assertNumbersGrounded } from '../../src/platform/assistant/grounding';
import type { Citation, ToolRun } from './assistant-tools';

export interface AssistantTurn {
  stopReason: string | null;
  model: string;
  text: string;
  toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }>;
}
/** One model call. Injected so tests and previews never spend. */
export type ModelCaller = (question: string, transcript: TranscriptEntry[]) => Promise<AssistantTurn>;
export type TranscriptEntry =
  | { role: 'assistant'; turn: AssistantTurn }
  | { role: 'tool_results'; results: Array<{ toolUseId: string; content: string }> };

export const MAX_MODEL_CALLS = 4;

export const ASSISTANT_SYSTEM = `You answer an operator's question about their own business, read-only.
Rules, all hard:
- Use the tools to look up records; answer only from what they return. If the tools cannot see it, say so plainly.
- Use only numbers that appear in the tool results or the question, written exactly as they appear. Never total, convert or estimate.
- Two to five plain sentences. No advice beyond what the records state.`;

export interface AssistantAnswer { answer: string; citations: Citation[]; model: string }

/** Ask one question: a bounded tool loop, then a grounded answer. Throws with a fixed
 * 'assistant failed:' reason on anything that must not be shown as an answer. */
export async function askAssistant(question: string,
  deps: { call: ModelCaller; execute: (name: string, args: Record<string, unknown>) => Promise<ToolRun> }): Promise<AssistantAnswer> {
  const transcript: TranscriptEntry[] = [];
  const citations: Citation[] = [];
  const evidence: string[] = [question];
  let modelId = '';
  for (let call = 0; call < MAX_MODEL_CALLS; call++) {
    const turn = await deps.call(question, transcript);
    modelId = turn.model;
    if (turn.stopReason === 'refusal') throw new Error('assistant failed: the model declined this question');
    if (turn.toolUses.length === 0) {
      if (turn.stopReason !== 'end_turn' || !turn.text.trim()) throw new Error(`assistant failed: the answer stopped early (${turn.stopReason ?? 'no output'})`);
      assertNumbersGrounded(evidence.join('\n'), turn.text, 'assistant answer');
      return { answer: turn.text.trim(), citations, model: modelId };
    }
    transcript.push({ role: 'assistant', turn });
    const results: Array<{ toolUseId: string; content: string }> = [];
    for (const use of turn.toolUses) {
      const run = await deps.execute(use.name, use.input);
      citations.push(run.citation);
      const content = JSON.stringify(run.result);
      evidence.push(content);
      results.push({ toolUseId: use.id, content });
    }
    transcript.push({ role: 'tool_results', results });
  }
  throw new Error('assistant failed: no answer within the allowed number of model calls');
}

/** Outcome codes of the ask action, carried in the redirect back to /assistant. Only
 * these fixed messages are shown; nothing from the URL or the model error is echoed. */
export const ASSISTANT_OUTCOMES = {
  answered: { ok: true, text: 'Answered. The citations under the answer are the queries that were actually run.' },
  failed_grounding: { ok: false, text: 'The answer introduced a figure the queried records do not carry, so it was rejected and recorded. Ask again, or check the records directly.' },
  declined: { ok: false, text: 'The model declined this question. The exchange is recorded.' },
  no_model: { ok: false, text: 'No model is configured on the console host (ANTHROPIC_API_KEY), so nothing was asked.' },
  not_allowed: { ok: false, text: 'The assistant is switched off for this business (its operator assistant.ask grant is missing or revoked). Nothing was asked.' },
  paused: { ok: false, text: 'Business actions are paused, so nothing was asked. Resume them first.' },
  question: { ok: false, text: 'Ask a question of up to 1000 characters. Nothing was asked.' },
  failed: { ok: false, text: 'The question could not be answered or recorded. The attempt is recorded where possible; try again.' },
} as const;
export type AssistantOutcome = keyof typeof ASSISTANT_OUTCOMES;

export function assistantOutcomeFor(errorMessage: string): AssistantOutcome {
  if (/introduces the number/.test(errorMessage)) return 'failed_grounding';
  if (/model declined/.test(errorMessage)) return 'declined';
  if (/business actions paused/.test(errorMessage)) return 'paused';
  if (/entitlement missing or revoked|must not require approval|agent disabled/.test(errorMessage)) return 'not_allowed';
  return 'failed';
}
export function isAssistantOutcome(value: unknown): value is AssistantOutcome {
  return typeof value === 'string' && Object.prototype.hasOwnProperty.call(ASSISTANT_OUTCOMES, value);
}
