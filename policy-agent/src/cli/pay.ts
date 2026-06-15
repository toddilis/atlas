// pay — one-off intent runner. Takes flags from argv and exercises the wrapped tool. Useful
// for manual testing and the demo recording. Example:
//
//   npm run pay -- --recipient 0.0.5001 --creator ABC --order 9999 --amount 5

import 'dotenv/config';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadConfig } from '../policy/config.js';
import { hbarToTinybar } from '../policy/types.js';
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

function arg(name: string): string {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1 || i + 1 >= process.argv.length) {
    throw new Error(`missing --${name}`);
  }
  const v = process.argv[i + 1];
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}

async function main() {
  const recipient = arg('recipient');
  const creatorCode = arg('creator');
  const orderId = arg('order');
  const amount = hbarToTinybar(arg('amount'));

  const topics = loadTopics();
  const config = loadConfig();

  const outcome = await payCreator(
    { recipient, creatorCode, orderId, amount, currency: 'HBAR' },
    {
      config,
      auditTopicId: topics.auditTopicId,
      confirm: cliConfirm,
      loadState: () => readState({
        conversionsTopicId: topics.conversionsTopicId,
        auditTopicId: topics.auditTopicId,
        now: Date.now(),
      }),
    },
  );

  console.log(`decision: ${outcome.decision.decision}`);
  for (const r of outcome.decision.reasons) console.log(`  ${r}`);
  if (outcome.kind === 'paid') console.log(`paid: ${outcome.hashscanUrl}`);
  else if (outcome.kind === 'aborted') console.log(`aborted: ${outcome.reason}`);
}

main().catch((e) => {
  console.error(`pay failed: ${(e as Error).message}`);
  process.exit(1);
});
