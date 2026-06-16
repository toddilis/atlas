// Loads + parses RuleConfig from the policy_rules table. Each row stores the config as
// jsonb; the loader converts string-encoded bigints back to bigint at the boundary.

import { supabase, orgId } from '../../data/supabase.js';
import type { RuleConfig } from './types.js';

interface JsonRules {
  perTransactionCap?: { amount: string | number };
  rollingWindow?: { amount: string | number; windowHours: number };
  velocityLimit?: { maxActions: number; windowHours: number };
  allowlist?: { attribute: string; values: Array<string | number> };
  denylist?: { attribute: string; values: Array<string | number> };
  approvalThreshold?: { amount: string | number };
  conditionalGate?: {
    requirePrecondition: boolean;
    precondition: string;
    matchAttribute: string;
    amountTolerance?: string | number;
  };
  idempotency?: { enabled: boolean; attribute: string };
}

function toBig(v: string | number): bigint {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.trunc(v));
  return BigInt(v);
}

export function parseConfig(json: JsonRules): RuleConfig {
  const config: RuleConfig = {};
  if (json.perTransactionCap) {
    config.perTransactionCap = { amount: toBig(json.perTransactionCap.amount) };
  }
  if (json.rollingWindow) {
    config.rollingWindow = {
      amount: toBig(json.rollingWindow.amount),
      windowHours: json.rollingWindow.windowHours,
    };
  }
  if (json.velocityLimit) {
    config.velocityLimit = { ...json.velocityLimit };
  }
  if (json.allowlist) config.allowlist = { ...json.allowlist };
  if (json.denylist) config.denylist = { ...json.denylist };
  if (json.approvalThreshold) {
    config.approvalThreshold = { amount: toBig(json.approvalThreshold.amount) };
  }
  if (json.conditionalGate) {
    config.conditionalGate = {
      requirePrecondition: json.conditionalGate.requirePrecondition,
      precondition: json.conditionalGate.precondition,
      matchAttribute: json.conditionalGate.matchAttribute,
      amountTolerance:
        json.conditionalGate.amountTolerance !== undefined
          ? toBig(json.conditionalGate.amountTolerance)
          : undefined,
    };
  }
  if (json.idempotency) config.idempotency = { ...json.idempotency };
  return config;
}

/**
 * Look up the current enabled rule set for an action. Returns null if no rule set is
 * configured — callers fall back to the legacy risk-tier grant in that case.
 */
export async function loadPolicyConfig(action: string): Promise<RuleConfig | null> {
  const sb = supabase();
  const { data, error } = await sb
    .from('policy_rules')
    .select('config')
    .eq('org_id', orgId())
    .eq('scope_action', action)
    .eq('enabled', true)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return parseConfig(data.config as JsonRules);
}
