// Hedera Consensus Service helpers — topic create, message submit, and a "query recent
// messages" helper that hits the public mirror node (so we don't require any extra setup).

import {
  TopicCreateTransaction,
  TopicMessageSubmitTransaction,
  TopicId,
} from '@hashgraph/sdk';
import { client } from './client.js';

export interface CreatedTopic {
  topicId: string;
  txId: string;
}

export async function createTopic(memo: string): Promise<CreatedTopic> {
  const tx = await new TopicCreateTransaction().setTopicMemo(memo).execute(client());
  const receipt = await tx.getReceipt(client());
  const topicId = receipt.topicId?.toString();
  if (!topicId) throw new Error('topic create returned no topic id');
  return { topicId, txId: tx.transactionId.toString() };
}

export interface SubmittedMessage {
  topicId: string;
  txId: string;
  sequenceNumber: bigint;
}

export async function submitMessage(
  topicId: string,
  payload: Record<string, unknown>,
): Promise<SubmittedMessage> {
  const body = JSON.stringify(payload);
  const tx = await new TopicMessageSubmitTransaction()
    .setTopicId(TopicId.fromString(topicId))
    .setMessage(body)
    .execute(client());
  const receipt = await tx.getReceipt(client());
  return {
    topicId,
    txId: tx.transactionId.toString(),
    sequenceNumber: BigInt(receipt.topicSequenceNumber?.toString() ?? '0'),
  };
}

export interface MirrorMessage {
  sequenceNumber: number;
  consensusTimestamp: string;
  payload: Record<string, unknown>;
}

const MIRROR_BASE = 'https://testnet.mirrornode.hedera.com/api/v1';

/**
 * Fetch the most recent messages from a topic via the testnet mirror node. Returns oldest
 * first. `limit` defaults to 100 (mirror node max page).
 */
export async function listMessages(topicId: string, limit = 100): Promise<MirrorMessage[]> {
  const url = `${MIRROR_BASE}/topics/${encodeURIComponent(topicId)}/messages?order=asc&limit=${limit}`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`mirror node ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as { messages?: Array<{
    sequence_number: number;
    consensus_timestamp: string;
    message: string;
  }> };
  return (json.messages ?? []).map((m) => ({
    sequenceNumber: m.sequence_number,
    consensusTimestamp: m.consensus_timestamp,
    payload: JSON.parse(Buffer.from(m.message, 'base64').toString('utf8')) as Record<string, unknown>,
  }));
}
