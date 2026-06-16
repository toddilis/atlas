// HBAR transfer — operator → recipient. Returns the transaction id for HashScan look-up
// and the audit log. The wrapped payment tool calls this ONLY after policy.evaluate()
// returns `allow` (or `escalate` → operator-confirmed).

import {
  AccountId,
  Hbar,
  HbarUnit,
  TransferTransaction,
} from '@hashgraph/sdk';
import { client, operatorEnv } from './client.js';

export interface TransferResult {
  txId: string;
  consensusStatus: string;
  hashscanUrl: string;
}

export async function transferHbar(
  recipient: string,
  tinybars: bigint,
): Promise<TransferResult> {
  if (tinybars <= 0n) throw new Error(`tinybars must be positive; got ${tinybars}`);
  const op = operatorEnv();

  const tx = new TransferTransaction()
    .addHbarTransfer(op.accountId, Hbar.fromTinybars((-tinybars).toString()))
    .addHbarTransfer(AccountId.fromString(recipient), Hbar.fromTinybars(tinybars.toString()));

  const submitted = await tx.execute(client());
  const receipt = await submitted.getReceipt(client());
  const txId = submitted.transactionId.toString();
  return {
    txId,
    consensusStatus: receipt.status.toString(),
    hashscanUrl: `https://hashscan.io/testnet/transaction/${encodeURIComponent(txId)}`,
  };
}

/** Format tinybars as a short HBAR display value (e.g. 5.5 ℏ). */
export function formatHbar(tinybars: bigint): string {
  return Hbar.fromTinybars(tinybars.toString()).toString(HbarUnit.Hbar);
}
