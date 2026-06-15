// LangChain agent runtime — wraps payCreator() as a tool the Claude agent can call.
//
// The agent is intentionally thin: a single tool (the wrapped payment tool) is exposed.
// Claude's job is parameter extraction — given a natural-language intent like
//   "pay creator ABC their commission on order 1042"
// the agent emits a tool call with { recipient, creatorCode, orderId, amount } and the
// policy engine runs as usual. Claude has NO access to a raw transferHbar tool, so any
// hallucinated intent that doesn't pass policy is structurally blocked.

import { tool } from '@langchain/core/tools';
import { ChatAnthropic } from '@langchain/anthropic';
import { createReactAgent } from '@langchain/langgraph/prebuilt';
import { z } from 'zod';

import type { Confirm } from '../hitl/prompt.js';
import { payCreator } from './tools/payCreator.js';
import { readState } from './tools/readState.js';
import { loadConfig } from '../policy/config.js';
import { hbarToTinybar } from '../policy/types.js';

export interface AgentDeps {
  conversionsTopicId: string;
  auditTopicId: string;
  confirm: Confirm;
}

const PayCreatorSchema = z.object({
  recipient: z.string().describe('Hedera account id of the recipient, e.g. 0.0.5001'),
  creatorCode: z.string().describe('Creator/affiliate code attributing the payment'),
  orderId: z.string().describe('Order id this payment settles'),
  amountHbar: z.string().describe('Amount in HBAR (human-readable, e.g. "5" or "12.5")'),
});

export function buildAgent(deps: AgentDeps) {
  const config = loadConfig();

  const payCreatorTool = tool(
    async (input) => {
      const outcome = await payCreator(
        {
          recipient: input.recipient,
          creatorCode: input.creatorCode,
          orderId: input.orderId,
          amount: hbarToTinybar(input.amountHbar),
          currency: 'HBAR',
        },
        {
          config,
          auditTopicId: deps.auditTopicId,
          confirm: deps.confirm,
          loadState: () => readState({
            conversionsTopicId: deps.conversionsTopicId,
            auditTopicId: deps.auditTopicId,
            now: Date.now(),
          }),
        },
      );
      return JSON.stringify(outcome);
    },
    {
      name: 'pay_creator',
      description:
        'Pay a creator their commission on a specific order. The payment is subject to ' +
        'the policy engine (verified-conversion gate, caps, allowlist, idempotency, etc.). ' +
        'May return blocked or aborted; only allow → paid produces an on-chain transfer.',
      schema: PayCreatorSchema,
    },
  );

  const model = new ChatAnthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-6',
  });

  return createReactAgent({
    llm: model,
    tools: [payCreatorTool],
    prompt:
      'You are a payment agent. The user gives you an intent to pay a creator their ' +
      'commission. Extract the recipient account id, creator code, order id, and amount, ' +
      'and call the `pay_creator` tool. Report the outcome to the user verbatim, including ' +
      'the policy decision and reasons.',
  });
}
