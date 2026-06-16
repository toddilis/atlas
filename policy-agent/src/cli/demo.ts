// demo — runs the five scenarios from the build brief §9 end-to-end. Each scenario builds
// a Payment intent, calls payCreator() (the wrapped tool), and prints the decision, audit
// outcome, and (where applicable) the HashScan URL of the on-chain transfer.

import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../policy/config.js';
import { hbarToTinybar, type Payment, type PaymentRecord } from '../policy/types.js';
import { cliConfirm } from '../hitl/prompt.js';
import { payCreator } from '../agent/tools/payCreator.js';
import { readState } from '../agent/tools/readState.js';

interface Topics {
  conversionsTopicId: string;
  auditTopicId: string;
}

function loadTopics(): Topics {
  const fromEnv = {
    conversionsTopicId: process.env.HCS_CONVERSIONS_TOPIC_ID ?? '',
    auditTopicId: process.env.HCS_AUDIT_TOPIC_ID ?? '',
  };
  if (fromEnv.conversionsTopicId && fromEnv.auditTopicId) return fromEnv;
  const path = resolve(process.cwd(), '.topics.json');
  if (!existsSync(path)) {
    throw new Error('No topics — set HCS_*_TOPIC_ID env or run `npm run hedera:topics`');
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Topics;
}

interface Scenario {
  label: string;
  expected: 'paid' | 'blocked' | 'aborted' | 'paid-after-hitl';
  payment: Payment;
}

function buildScenarios(): Scenario[] {
  const recipient = process.env.DEMO_RECIPIENT_ID;
  if (!recipient) throw new Error('DEMO_RECIPIENT_ID must be set');

  // Scenarios sequenced so each one demonstrates exactly one policy decision cleanly.
  // Cumulative in-process spend after each `allow`:
  //   after 1: 18 HBAR (ABC)
  //   after 2: 93 HBAR (after operator approves the escalate)
  //   3: blocks by rollingWindow alone (93 + 25 = 118 > 100; 25 < 50 threshold)
  //   4: blocks by allowlist (creator not permitted)
  //   5: blocks by idempotency (order already paid in scenario 1)
  return [
    {
      label: '1) Happy path: verified ABC, within caps → allow',
      expected: 'paid',
      payment: {
        recipient, creatorCode: 'ABC', orderId: 'order-1042',
        amount: hbarToTinybar('18'), currency: 'HBAR',
      },
    },
    {
      label: '2) Over threshold: DEF 75 HBAR > 50 → escalate → HITL',
      expected: 'paid-after-hitl',
      payment: {
        recipient, creatorCode: 'DEF', orderId: 'order-1044',
        amount: hbarToTinybar('75'), currency: 'HBAR',
      },
    },
    {
      label: '3) Rolling cap hit: ABC order-1046 (93 already spent + 25 > 100 cap) → block',
      expected: 'blocked',
      payment: {
        recipient, creatorCode: 'ABC', orderId: 'order-1046',
        amount: hbarToTinybar('25'), currency: 'HBAR',
      },
    },
    {
      label: '4) Not allowlisted: ZZZ creator code missing → block',
      expected: 'blocked',
      payment: {
        recipient, creatorCode: 'ZZZ', orderId: 'order-2001',
        amount: hbarToTinybar('5'), currency: 'HBAR',
      },
    },
    {
      label: '5) Duplicate: re-run ABC order-1042 → block (idempotency)',
      expected: 'blocked',
      payment: {
        recipient, creatorCode: 'ABC', orderId: 'order-1042',
        amount: hbarToTinybar('18'), currency: 'HBAR',
      },
    },
  ];
}

async function main() {
  const topics = loadTopics();
  const config = loadConfig();
  const scenarios = buildScenarios();

  // Mirror-node indexing has ~5-10s lag, so back-to-back scenarios may not see the audit
  // message of the previous payment yet. We compensate by tracking what we've paid in this
  // process and merging it into the state passed to the engine — exactly how a production
  // agent would track its own in-flight commitments before mirror-node confirmation.
  const inProcessPayments: PaymentRecord[] = [];

  for (const s of scenarios) {
    console.log('\n' + '─'.repeat(72));
    console.log(s.label);
    console.log('─'.repeat(72));

    const outcome = await payCreator(s.payment, {
      config,
      auditTopicId: topics.auditTopicId,
      confirm: cliConfirm,
      loadState: async () => {
        const fromHcs = await readState({
          conversionsTopicId: topics.conversionsTopicId,
          auditTopicId: topics.auditTopicId,
          now: Date.now(),
        });
        // Merge in-process payments AFTER the HCS-fetched ones; the engine doesn't care
        // about order, but consistent ordering keeps reasons-array output stable.
        const mergedRecent = [...fromHcs.recentPayments, ...inProcessPayments];
        const mergedPaid = new Set(fromHcs.paidOrderIds);
        for (const p of inProcessPayments) mergedPaid.add(p.payment.orderId);
        return {
          ...fromHcs,
          recentPayments: mergedRecent,
          paidOrderIds: mergedPaid,
        };
      },
    });

    console.log(`decision: ${outcome.decision.decision}`);
    for (const r of outcome.decision.reasons) console.log(`  ${r}`);
    if (outcome.kind === 'paid') {
      console.log(`paid: ${outcome.hashscanUrl}`);
      inProcessPayments.push({
        payment: s.payment,
        occurredAt: Date.now(),
        txId: outcome.txId,
        decision: 'allow',
      });
    } else if (outcome.kind === 'aborted') {
      console.log(`aborted by operator: ${outcome.reason}`);
    }
  }
}

main().catch((e) => {
  console.error(`demo failed: ${(e as Error).message}`);
  process.exit(1);
});
