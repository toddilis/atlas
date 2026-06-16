// Hedera SDK client — operator-authenticated, testnet only.
//
// The client is lazy: constructing the module does nothing; `client()` reads HEDERA_OPERATOR_ID
// + HEDERA_OPERATOR_KEY from the environment on first call and throws loudly if missing.
//
// Keep the surface tiny — submit-tx + balance-check + the kit wiring. Higher-level helpers
// (HCS topic create / message submit / query) live in topics.ts and hcs.ts.

import { Client, AccountId, PrivateKey } from '@hashgraph/sdk';

let cached: Client | null = null;

export interface OperatorEnv {
  network: 'testnet' | 'mainnet' | 'previewnet';
  accountId: AccountId;
  privateKey: PrivateKey;
}

export function operatorEnv(): OperatorEnv {
  const network = (process.env.HEDERA_NETWORK ?? 'testnet') as OperatorEnv['network'];
  const accountIdRaw = process.env.HEDERA_OPERATOR_ID;
  const privateKeyRaw = process.env.HEDERA_OPERATOR_KEY;
  if (!accountIdRaw) throw new Error('HEDERA_OPERATOR_ID must be set');
  if (!privateKeyRaw) throw new Error('HEDERA_OPERATOR_KEY must be set');
  if (network !== 'testnet') {
    throw new Error(
      `HEDERA_NETWORK=${network} not supported — this project is testnet only by design`,
    );
  }
  return {
    network,
    accountId: AccountId.fromString(accountIdRaw),
    privateKey: parsePrivateKey(privateKeyRaw),
  };
}

function parsePrivateKey(raw: string): PrivateKey {
  // Accept either ECDSA or ED25519, in DER- or hex-encoded form. The portal hands out:
  //   - ECDSA (recommended): hex, 64 chars, no DER prefix. We try ECDSA first.
  //   - ED25519: DER-encoded, starts with '302e' / '3030', OR raw hex.
  // `fromStringDer` works for both DER-encoded forms regardless of curve.
  const trimmed = raw.trim().replace(/^0x/i, '');
  if (trimmed.startsWith('302e') || trimmed.startsWith('3030')) {
    return PrivateKey.fromStringDer(trimmed);
  }
  // Hex / raw key — try ECDSA first (the portal's recommended default), fall back to ED25519.
  try {
    return PrivateKey.fromStringECDSA(trimmed);
  } catch {
    return PrivateKey.fromStringED25519(trimmed);
  }
}

export function client(): Client {
  if (cached) return cached;
  const env = operatorEnv();
  const c = Client.forTestnet();
  c.setOperator(env.accountId, env.privateKey);
  cached = c;
  return cached;
}
