// payCreator — the WRAPPED payment tool.
//
// This is the ONLY function in the system that calls transferHbar(). Every other code
// path — the LangChain agent, the CLI, the demo scenarios — exercises payments through
// this single entry point. The interception test (test/interception.test.ts) asserts
// statically that no other file imports `transferHbar` directly.
//
// Contract:
//   1. Build a `Payment` from the intent.
//   2. Build `PolicyState` from the audit + conversions topics.
//   3. evaluate(payment, state, config).
//   4. Switch on decision:
//        block    → submit decision to audit topic, return; no transfer.
//        escalate → submit decision to audit topic, prompt HITL; on confirm fall through to allow.
//        allow    → transferHbar(); submit receipt to audit topic.
//
// A `block` decision MUST NEVER reach `transferHbar`. This is the structural property
// that satisfies the bounty's "cannot drain funds without consent" safety rule — there
// is no in-band path from `block` to a chain call.

import type { Confirm } from '../../hitl/prompt.js';
import { evaluate } from '../../policy/evaluate.js';
import type {
  Decision,
  Payment,
  PolicyState,
  RuleConfig,
} from '../../policy/types.js';
import { tinybarToHbar } from '../../policy/types.js';
import { submitMessage } from '../../hedera/hcs.js';
import { transferHbar, formatHbar } from '../../hedera/transfer.js';

export interface PayCreatorDeps {
  config: RuleConfig;
  auditTopicId: string;
  confirm: Confirm;
  /** Builds the current PolicyState. Caller usually wires this to readState() */
  loadState: () => Promise<PolicyState>;
}

export type PayCreatorOutcome =
  | { kind: 'paid'; txId: string; hashscanUrl: string; decision: Decision }
  | { kind: 'blocked'; decision: Decision }
  | { kind: 'aborted'; decision: Decision; reason: string };

export async function payCreator(
  payment: Payment,
  deps: PayCreatorDeps,
): Promise<PayCreatorOutcome> {
  const state = await deps.loadState();
  const decision = evaluate(payment, state, deps.config);

  if (decision.decision === 'block') {
    await auditDecision(deps.auditTopicId, payment, decision, null);
    return { kind: 'blocked', decision };
  }

  if (decision.decision === 'escalate') {
    await auditDecision(deps.auditTopicId, payment, decision, null);
    const summary = describeForOperator(payment, decision);
    const ok = await deps.confirm(summary);
    if (!ok) {
      const aborted: Decision = {
        decision: 'block',
        reasons: [...decision.reasons, '[hitl] operator declined'],
      };
      await auditDecision(deps.auditTopicId, payment, aborted, null);
      return { kind: 'aborted', decision: aborted, reason: 'operator declined' };
    }
    // fall through to allow — operator confirmed the escalate
  }

  // decision is now `allow` (either directly or via confirmed escalate).
  const receipt = await transferHbar(payment.recipient, payment.amount);
  await auditDecision(deps.auditTopicId, payment, decision, receipt.txId);
  return {
    kind: 'paid',
    txId: receipt.txId,
    hashscanUrl: receipt.hashscanUrl,
    decision,
  };
}

function describeForOperator(payment: Payment, decision: Decision): string {
  return [
    `Payment requires approval:`,
    `  recipient: ${payment.recipient}`,
    `  creator:   ${payment.creatorCode}`,
    `  order:     ${payment.orderId}`,
    `  amount:    ${formatHbar(payment.amount)}`,
    `  reasons:`,
    ...decision.reasons.map((r) => `    - ${r}`),
    `Approve?`,
  ].join('\n');
}

async function auditDecision(
  topicId: string,
  payment: Payment,
  decision: Decision,
  txId: string | null,
): Promise<void> {
  await submitMessage(topicId, {
    type: 'policy_decision',
    decision: decision.decision,
    reasons: decision.reasons,
    payment: {
      recipient: payment.recipient,
      creatorCode: payment.creatorCode,
      orderId: payment.orderId,
      amount: tinybarToHbar(payment.amount),
      currency: payment.currency,
    },
    txId,
    decidedAt: new Date().toISOString(),
  });
}
