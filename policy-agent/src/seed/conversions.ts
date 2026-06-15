// Seed the demo's verified conversions onto the conversions HCS topic. Idempotent in the
// sense that re-running adds duplicate messages (HCS is append-only) but the policy engine
// dedups by (creatorCode, orderId) — the first matching verified conversion wins.

import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { submitMessage } from '../hedera/hcs.js';

interface Topics {
  conversionsTopicId: string;
  auditTopicId: string;
}

function loadTopics(): Topics {
  // Prefer env vars; fall back to .topics.json.
  const fromEnv = {
    conversionsTopicId: process.env.HCS_CONVERSIONS_TOPIC_ID ?? '',
    auditTopicId: process.env.HCS_AUDIT_TOPIC_ID ?? '',
  };
  if (fromEnv.conversionsTopicId && fromEnv.auditTopicId) return fromEnv;

  const path = resolve(process.cwd(), '.topics.json');
  if (!existsSync(path)) {
    throw new Error('No topics found — set HCS_*_TOPIC_ID env vars or run `npm run hedera:topics`');
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Topics;
}

const DEMO_CONVERSIONS = [
  // Happy path — verified, within all caps
  {
    type: 'conversion',
    creatorCode: 'ABC',
    orderId: 'order-1042',
    orderValue: '120',
    commission: '18',
    verifiedAt: new Date().toISOString(),
    status: 'verified',
  },
  // Rolling-cap test target. With rollingWindow = 30 HBAR / 168h and the
  // happy-path scenario already spending 18 HBAR, a 25 HBAR payment here
  // pushes the window sum to 43 → blocked by rollingWindow. Stays under
  // the 50 HBAR approvalThreshold so it doesn't escalate first.
  {
    type: 'conversion',
    creatorCode: 'ABC',
    orderId: 'order-1046',
    orderValue: '200',
    commission: '25',
    verifiedAt: new Date().toISOString(),
    status: 'verified',
  },
  // Above approval threshold → escalate
  {
    type: 'conversion',
    creatorCode: 'DEF',
    orderId: 'order-1044',
    orderValue: '500',
    commission: '75',
    verifiedAt: new Date().toISOString(),
    status: 'verified',
  },
  // Duplicate-test target (gets paid once, then re-attempt should be blocked)
  {
    type: 'conversion',
    creatorCode: 'GHI',
    orderId: 'order-1045',
    orderValue: '200',
    commission: '20',
    verifiedAt: new Date().toISOString(),
    status: 'verified',
  },
] as const;

async function main() {
  const topics = loadTopics();
  console.log(`Seeding ${DEMO_CONVERSIONS.length} verified conversions to ${topics.conversionsTopicId}...`);
  for (const c of DEMO_CONVERSIONS) {
    const r = await submitMessage(topics.conversionsTopicId, c);
    console.log(`  seq=${r.sequenceNumber} ${c.creatorCode} ${c.orderId} commission=${c.commission} HBAR tx=${r.txId}`);
  }
  console.log('Done.');
}

main().catch((e) => {
  console.error(`seed failed: ${(e as Error).message}`);
  process.exit(1);
});
