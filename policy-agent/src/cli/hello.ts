// hello — Phase 0 sanity test. Makes one HBAR transfer from the operator to DEMO_RECIPIENT_ID
// and prints the HashScan URL. Run after putting HEDERA_OPERATOR_ID + HEDERA_OPERATOR_KEY +
// DEMO_RECIPIENT_ID into .env. Confirms the rail before any policy work is layered on.
//
// Intentionally uses the Hedera SDK directly: this is a dev-only smoke test, not a
// customer-facing payment path. The interception invariant (no caller of transferHbar()
// outside the wrapped payment tool) is preserved.

import 'dotenv/config';
import {
  AccountId,
  Hbar,
  HbarUnit,
  TransferTransaction,
} from '@hashgraph/sdk';
import { client, operatorEnv } from '../hedera/client.js';

async function main() {
  const recipientRaw = process.env.DEMO_RECIPIENT_ID;
  if (!recipientRaw) throw new Error('DEMO_RECIPIENT_ID must be set');

  const op = operatorEnv();
  const recipient = AccountId.fromString(recipientRaw);
  const amount = Hbar.from(1, HbarUnit.Hbar);                   // 1 HBAR

  console.log(`Transferring 1 HBAR ${op.accountId.toString()} → ${recipient.toString()}...`);
  const tx = await new TransferTransaction()
    .addHbarTransfer(op.accountId, amount.negated())
    .addHbarTransfer(recipient, amount)
    .execute(client());
  const receipt = await tx.getReceipt(client());
  const txId = tx.transactionId.toString();
  console.log(`OK consensus=${receipt.status.toString()} tx=${txId}`);
  console.log(`HashScan: https://hashscan.io/testnet/transaction/${encodeURIComponent(txId)}`);
}

main().catch((e) => {
  console.error(`hello failed: ${(e as Error).message}`);
  process.exit(1);
});
