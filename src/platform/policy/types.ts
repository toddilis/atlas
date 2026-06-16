// Policy engine — type contract.
//
// The engine is PURE: every function in this module is deterministic and has zero I/O.
// Inputs are a `PolicyInput` describing what the agent intends to do, a `PolicyState`
// describing what's already happened that's relevant, and a `RuleConfig` describing what's
// allowed. The output is a `Decision` with the aggregated outcome and the list of reasons
// every contributing rule produced.
//
// Atlas-wide convention: amounts are bigint in the smallest unit of the named currency
// (cents for NZD/USD/AUD/EUR; tinybars for HBAR; etc.). The currency code is ISO 4217.
// Rules never inspect currency — they compare bigints. The currency is carried for
// downstream display, ledger posting, and audit.

/**
 * What the agent wants to do. The `action` matches the registered ToolDefinition name.
 * `subject*` identifies the target row. `amount` + `currency` are present when the action
 * moves money. `attributes` is a domain-specific bag that individual rules read.
 *
 * For wholesale invoice issuance (the first Atlas consumer):
 *   action: 'controller.issue_invoice'
 *   subjectType: 'invoice'
 *   subjectId: <invoice id>
 *   amount: <invoice total in cents>
 *   currency: 'NZD'
 *   attributes: {
 *     account_id, fulfillment_event_id, shopify_order_id,
 *     ...whatever specific rules need
 *   }
 */
export interface PolicyInput {
  action: string;
  subjectType: string;
  subjectId: string;
  amount: bigint;
  currency: string;
  attributes: Record<string, string | number | boolean | null>;
}

/**
 * What the engine knows about the world that's relevant to evaluating this input. Built
 * by `src/platform/policy/state.ts` from canonical Atlas tables — never inspected by the
 * caller directly.
 */
export interface PolicyState {
  /** Recent successful (allow-decided) money-moving actions of the same `action` kind. */
  recentActions: ActionRecord[];

  /**
   * Set of subject ids in this scope that have already been acted on successfully — feeds
   * the idempotency rule. For wholesale invoicing this is fulfillment_event_ids already
   * invoiced; for creator payouts it's orderIds already paid; etc.
   */
  completedSubjectKeys: Set<string>;

  /** Verified pre-conditions that gate the action — feeds the conditionalGate rule. */
  preconditions: Precondition[];

  /** Injected for determinism; tests pass a fixed value. */
  now: number;
}

export interface ActionRecord {
  action: string;
  subjectType: string;
  subjectId: string;
  amount: bigint;
  currency: string;
  attributes: Record<string, string | number | boolean | null>;
  occurredAt: number;
  txRef: string | null;
  decision: DecisionKind;
}

/**
 * A verified pre-condition (e.g. a fulfilled wholesale order ready to invoice; a verified
 * affiliate conversion ready to pay). The conditionalGate rule looks up a matching one by
 * the input's attributes and asserts the requested amount aligns.
 */
export interface Precondition {
  kind: string;                                           // 'wholesale_fulfillment', 'affiliate_conversion', etc.
  /** Free-form identifier the rule + input agree on (e.g. fulfillment_event_id). */
  key: string;
  amount: bigint;
  currency: string;
  attributes: Record<string, string | number | boolean | null>;
  verifiedAt: number;
}

export type DecisionKind = 'allow' | 'block' | 'escalate';

export interface Decision {
  decision: DecisionKind;
  reasons: string[];
}

// ---------- rule config ----------

export interface PerTransactionCapConfig {
  amount: bigint;
}

export interface RollingWindowConfig {
  amount: bigint;
  windowHours: number;
}

export interface VelocityLimitConfig {
  maxActions: number;
  windowHours: number;
}

export interface AllowlistConfig {
  /**
   * Attribute key (e.g. 'account_id', 'creator_code') paired with permitted values. A
   * rule passes if input.attributes[key] is in values.
   */
  attribute: string;
  values: Array<string | number>;
}

export interface DenylistConfig {
  attribute: string;
  values: Array<string | number>;
}

export interface ApprovalThresholdConfig {
  amount: bigint;
}

export interface ConditionalGateConfig {
  requirePrecondition: boolean;
  /**
   * Which precondition kind to look for. The rule matches when state.preconditions has an
   * entry with `kind === precondition` AND `key === input.attributes[matchAttribute]`.
   */
  precondition: string;
  matchAttribute: string;
  /** Tolerance in smallest units; defaults to 0 (must match exactly). */
  amountTolerance?: bigint;
}

export interface IdempotencyConfig {
  enabled: boolean;
  /**
   * Which attribute on the input acts as the de-duplication key. For wholesale invoicing,
   * 'fulfillment_event_id'. For payouts, 'order_id'.
   */
  attribute: string;
}

export interface RuleConfig {
  perTransactionCap?: PerTransactionCapConfig;
  rollingWindow?: RollingWindowConfig;
  velocityLimit?: VelocityLimitConfig;
  allowlist?: AllowlistConfig;
  denylist?: DenylistConfig;
  approvalThreshold?: ApprovalThresholdConfig;
  conditionalGate?: ConditionalGateConfig;
  idempotency?: IdempotencyConfig;
}

// ---------- per-rule result ----------

export interface RuleResult {
  rule: string;
  decision: DecisionKind;
  reason?: string;
}

export type Rule = (
  input: PolicyInput,
  state: PolicyState,
  config: RuleConfig,
) => RuleResult | null;

// ---------- amount helpers (currency-aware) ----------

/**
 * Convert a human-readable major-unit amount (e.g. "12.50") to bigint smallest-unit.
 * Defaults to 100 minor units per major (covers NZD / USD / AUD / EUR / GBP). Pass
 * `minorPerMajor = 1` for zero-decimal currencies like JPY.
 */
export function toMinor(amount: number | string, minorPerMajor = 100): bigint {
  const s = typeof amount === 'number' ? amount.toString() : amount.trim();
  const decimals = Math.floor(Math.log10(minorPerMajor) + 0.0001);
  const pattern = new RegExp(`^-?\\d+(\\.\\d{1,${decimals}})?$`);
  if (!pattern.test(s)) {
    throw new Error(`invalid amount for minorPerMajor=${minorPerMajor}: ${amount}`);
  }
  const [whole, frac = ''] = s.startsWith('-') ? s.slice(1).split('.') : s.split('.');
  if (whole === undefined) throw new Error(`invalid amount: ${amount}`);
  const negative = s.startsWith('-');
  const fracPadded = (frac + '0'.repeat(decimals)).slice(0, decimals);
  const result = BigInt(whole) * BigInt(minorPerMajor) + BigInt(fracPadded || '0');
  return negative ? -result : result;
}

/** Display bigint smallest-unit as a major-unit string. */
export function toMajor(minor: bigint, minorPerMajor = 100): string {
  const negative = minor < 0n;
  const abs = negative ? -minor : minor;
  const whole = abs / BigInt(minorPerMajor);
  const frac = abs % BigInt(minorPerMajor);
  const decimals = Math.floor(Math.log10(minorPerMajor) + 0.0001);
  let s = whole.toString();
  if (decimals > 0 && frac > 0n) {
    const fracStr = frac.toString().padStart(decimals, '0').replace(/0+$/, '');
    if (fracStr.length > 0) s += '.' + fracStr;
  }
  return negative ? '-' + s : s;
}
