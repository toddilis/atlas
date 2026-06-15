// Anthropic client — narration / approval-summary / assistant only. Never on the money path.
// Phase 0 wires the import + env, but the only callers are deferred (Phase 2 assistant +
// digest narration). Anthropic SDK is the only LLM provider (§10).

import Anthropic from '@anthropic-ai/sdk';

let cached: Anthropic | null = null;

export function anthropic(): Anthropic {
  if (cached) return cached;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY must be set');
  cached = new Anthropic({ apiKey });
  return cached;
}

export function model(): string {
  return process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6';
}
