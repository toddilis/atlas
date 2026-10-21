// Console ask action. The operator is verified here (session, allowlist, same origin) and
// the grant is checked before any model call so a switched-off assistant spends nothing;
// record_assistant_exchange re-enforces pause and the grant when the exchange is stored.
// Every outcome — answered, rejected by grounding, declined — is recorded as evidence.

import 'server-only';
import Anthropic from '@anthropic-ai/sdk';
import { OperatorAuthError, requireOperator } from './auth-server';
import { supabaseServer } from './supabase';
import { askAssistant, assistantOutcomeFor, ASSISTANT_SYSTEM, type AssistantOutcome, type ModelCaller, type TranscriptEntry } from './assistant';
import { ASSISTANT_TOOL_DEFS, executeAssistantTool, type Citation } from './assistant-tools';

const back = (outcome: AssistantOutcome) => new Response(null, { status: 303, headers: { Location: `/assistant?outcome=${outcome}` } });

function toMessages(question: string, transcript: TranscriptEntry[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [{ role: 'user', content: question }];
  for (const entry of transcript) {
    if (entry.role === 'assistant') {
      messages.push({
        role: 'assistant',
        content: [
          ...(entry.turn.text.trim() ? [{ type: 'text' as const, text: entry.turn.text }] : []),
          ...entry.turn.toolUses.map(use => ({ type: 'tool_use' as const, id: use.id, name: use.name, input: use.input })),
        ],
      });
    } else {
      messages.push({ role: 'user', content: entry.results.map(r => ({ type: 'tool_result' as const, tool_use_id: r.toolUseId, content: r.content })) });
    }
  }
  return messages;
}

const callClaude: ModelCaller = async (question, transcript) => {
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const modelId = process.env.ANTHROPIC_MODEL ?? 'claude-opus-5-5';
  const response = await client.messages.create({
    model: modelId, max_tokens: 2048, system: ASSISTANT_SYSTEM,
    tools: ASSISTANT_TOOL_DEFS as Anthropic.Tool[],
    messages: toMessages(question, transcript),
  });
  return {
    stopReason: response.stop_reason,
    model: response.model,
    text: response.content.filter(b => b.type === 'text').map(b => b.text).join('').trim(),
    toolUses: response.content.filter(b => b.type === 'tool_use').map(b => ({ id: b.id, name: b.name, input: b.input as Record<string, unknown> })),
  };
};

export async function askAssistantAction(request: Request) {
  let operator: Awaited<ReturnType<typeof requireOperator>>;
  try {
    operator = await requireOperator(request);
  } catch (error) {
    if (!(error instanceof OperatorAuthError)) throw error;
    if (error.status === 401) return new Response(null, { status: 303, headers: { Location: '/login' } });
    return Response.json({ error: error.message }, { status: error.status });
  }
  const form = await request.formData();
  const question = form.get('question');
  if (typeof question !== 'string' || !question.trim() || question.length > 1000) return back('question');
  if (!process.env.ANTHROPIC_API_KEY?.trim()) return back('no_model');

  // Fail closed before any spend; the recording RPC re-enforces both at write time.
  const sb = await supabaseServer();
  const [grants, controls] = await Promise.all([
    sb.from('tool_grants').select('enabled, risk').eq('org_id', operator.orgId).eq('agent_name', 'operator').eq('tool_name', 'assistant.ask'),
    sb.from('action_controls').select('paused').eq('org_id', operator.orgId).maybeSingle(),
  ]);
  if (grants.error) throw grants.error;
  if (controls.error) throw controls.error;
  if (controls.data?.paused) return back('paused');
  if (!(grants.data ?? []).some(g => g.enabled && g.risk !== 'approve_required')) return back('not_allowed');

  const record = async (args: { answer: string | null; citations: Citation[]; model: string; status: 'ok' | 'failed'; error: string | null }) => {
    const { error } = await sb.rpc('record_assistant_exchange', {
      p_org_id: operator.orgId, p_actor_id: operator.actorId, p_actor_email: operator.email,
      p_question: question.trim(), p_answer: args.answer as unknown as string,
      p_citations: args.citations as unknown as import('../../src/data/database.types').Json,
      p_model: args.model, p_status: args.status, p_error: args.error as unknown as string,
    });
    if (error) throw error;
  };

  try {
    const result = await askAssistant(question.trim(), { call: callClaude, execute: executeAssistantTool });
    await record({ answer: result.answer, citations: result.citations, model: result.model, status: 'ok', error: null });
    return back('answered');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const outcome = assistantOutcomeFor(message);
    try {
      await record({ answer: null, citations: [], model: process.env.ANTHROPIC_MODEL ?? 'claude-opus-5-5', status: 'failed', error: message.slice(0, 500) });
    } catch (recordError) {
      const recordMessage = recordError instanceof Error ? recordError.message : String(recordError);
      console.error('assistant.record_failed', { error: recordMessage });
      return back(assistantOutcomeFor(recordMessage));
    }
    if (outcome === 'failed') console.error('assistant.ask_failed', { error: message });
    return back(outcome);
  }
}
