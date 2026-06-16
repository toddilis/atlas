// topics — create the conversions + audit HCS topics and print their ids. The output is
// also written to .topics.json so the demo + seed scripts can find them without you having
// to copy-paste back into .env. You CAN paste them into .env to pin them across runs.

import 'dotenv/config';
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createTopic } from '../hedera/hcs.js';

async function main() {
  console.log('Creating HCS topic for verified conversions...');
  const conv = await createTopic('atlas-policy-agent: conversions');
  console.log(`  id=${conv.topicId} tx=${conv.txId}`);

  console.log('Creating HCS topic for audit log...');
  const audit = await createTopic('atlas-policy-agent: audit');
  console.log(`  id=${audit.topicId} tx=${audit.txId}`);

  const out = {
    conversionsTopicId: conv.topicId,
    auditTopicId: audit.topicId,
    createdAt: new Date().toISOString(),
  };
  const path = resolve(process.cwd(), '.topics.json');
  writeFileSync(path, JSON.stringify(out, null, 2) + '\n');
  console.log(`\nWrote ${path}. You can also paste these into .env:`);
  console.log(`  HCS_CONVERSIONS_TOPIC_ID=${conv.topicId}`);
  console.log(`  HCS_AUDIT_TOPIC_ID=${audit.topicId}`);
}

main().catch((e) => {
  console.error(`topics failed: ${(e as Error).message}`);
  process.exit(1);
});
