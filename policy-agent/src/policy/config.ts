// JSON config → typed RuleConfig. The JSON file ships bigints as strings so we don't
// rely on JS number precision for tinybar amounts. `loadConfig()` reads + validates;
// `parseConfig()` converts the JSON shape into the engine's types.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import type { RuleConfig } from './types.js';
import { hbarToTinybar } from './types.js';

interface JsonRules {
  perTransactionCap?: number | string;
  rollingWindow?: { amount: number | string; windowHours: number };
  velocityLimit?: { maxPayments: number; windowHours: number };
  allowlist?: string[];
  denylist?: string[];
  approvalThreshold?: number | string;
  conditionalGate?: {
    requireVerifiedConversion: boolean;
    maxCommissionRate: number;
    amountTolerance?: number | string;
  };
  idempotency?: { enabled: boolean };
}

interface JsonConfig {
  currency: 'HBAR';
  rules: JsonRules;
}

export function parseConfig(json: JsonConfig): RuleConfig {
  if (json.currency !== 'HBAR') {
    throw new Error(`unsupported currency: ${json.currency}`);
  }
  const r = json.rules;
  const config: RuleConfig = { currency: 'HBAR' };

  if (r.perTransactionCap !== undefined) {
    config.perTransactionCap = { amount: hbarToTinybar(r.perTransactionCap) };
  }
  if (r.rollingWindow) {
    config.rollingWindow = {
      amount: hbarToTinybar(r.rollingWindow.amount),
      windowHours: r.rollingWindow.windowHours,
    };
  }
  if (r.velocityLimit) {
    config.velocityLimit = {
      maxPayments: r.velocityLimit.maxPayments,
      windowHours: r.velocityLimit.windowHours,
    };
  }
  if (r.allowlist) config.allowlist = { entries: r.allowlist };
  if (r.denylist) config.denylist = { entries: r.denylist };
  if (r.approvalThreshold !== undefined) {
    config.approvalThreshold = { amount: hbarToTinybar(r.approvalThreshold) };
  }
  if (r.conditionalGate) {
    config.conditionalGate = {
      requireVerifiedConversion: r.conditionalGate.requireVerifiedConversion,
      maxCommissionRate: r.conditionalGate.maxCommissionRate,
      amountTolerance:
        r.conditionalGate.amountTolerance !== undefined
          ? hbarToTinybar(r.conditionalGate.amountTolerance)
          : undefined,
    };
  }
  if (r.idempotency) config.idempotency = r.idempotency;

  return config;
}

export function loadConfig(path = 'policy.config.json'): RuleConfig {
  const abs = resolve(process.cwd(), path);
  const raw = readFileSync(abs, 'utf8');
  const json = JSON.parse(raw) as JsonConfig;
  return parseConfig(json);
}
