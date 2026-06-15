// readState — builds PolicyState by reading the audit + conversions HCS topics.
//
// Source of truth:
//   - Conversions topic → state.verifiedConversions
//   - Audit topic → state.recentPayments + state.paidOrderIds
//
// Pure of policy logic — it shapes the state; the engine decides what to do with it.

import type { ConversionEvent, PaymentRecord, PolicyState } from '../../policy/types.js';
import { hbarToTinybar } from '../../policy/types.js';
import { listMessages } from '../../hedera/hcs.js';

export interface ReadStateInput {
  conversionsTopicId: string;
  auditTopicId: string;
  now: number;
}

interface AuditDecisionMessage {
  type: 'policy_decision';
  decision: 'allow' | 'block' | 'escalate';
  reasons: string[];
  payment: {
    recipient: string;
    creatorCode: string;
    orderId: string;
    amount: string;                    // human-readable HBAR
    currency: 'HBAR';
  };
  txId: string | null;
  decidedAt: string;
}

interface ConversionMessage {
  type: 'conversion';
  creatorCode: string;
  orderId: string;
  orderValue: string;
  commission: string;
  verifiedAt: string;
  status: 'verified';
}

export async function readState(input: ReadStateInput): Promise<PolicyState> {
  const [conv, audit] = await Promise.all([
    listMessages(input.conversionsTopicId),
    listMessages(input.auditTopicId),
  ]);

  const verifiedConversions: ConversionEvent[] = [];
  for (const m of conv) {
    if (m.payload.type !== 'conversion') continue;
    const c = m.payload as unknown as ConversionMessage;
    if (c.status !== 'verified') continue;
    verifiedConversions.push({
      type: 'conversion',
      creatorCode: c.creatorCode,
      orderId: c.orderId,
      orderValue: hbarToTinybar(c.orderValue),
      commission: hbarToTinybar(c.commission),
      verifiedAt: c.verifiedAt,
      status: 'verified',
    });
  }

  const recentPayments: PaymentRecord[] = [];
  const paidOrderIds = new Set<string>();
  for (const m of audit) {
    if (m.payload.type !== 'policy_decision') continue;
    const a = m.payload as unknown as AuditDecisionMessage;
    if (a.decision !== 'allow') continue;
    // Only count payments that actually made it on-chain.
    if (!a.txId) continue;
    const amount = hbarToTinybar(a.payment.amount);
    recentPayments.push({
      payment: {
        recipient: a.payment.recipient,
        creatorCode: a.payment.creatorCode,
        orderId: a.payment.orderId,
        amount,
        currency: 'HBAR',
      },
      occurredAt: Date.parse(a.decidedAt),
      txId: a.txId,
      decision: 'allow',
    });
    paidOrderIds.add(a.payment.orderId);
  }

  return {
    recentPayments,
    paidOrderIds,
    verifiedConversions,
    now: input.now,
  };
}
