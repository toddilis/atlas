// Policy engine — type contract.
//
// The engine is PURE: every function in this module is deterministic and has zero chain
// dependency. Inputs are a `Payment` (the proposed payout), a `PolicyState` (history +
// verified-conversion ledger), and a `RuleConfig` (the rule set). The output is a `Decision`
// with an aggregated `decision` and the list of `reasons` every rule contributed.
//
// HBAR amounts are carried as TINYBARS (1 HBAR = 100_000_000 tinybars) so all math is
// exact integer arithmetic. The CLI + config layer is responsible for converting human-
// readable HBAR (e.g. "5") into tinybars before the engine sees them.

export type Currency = 'HBAR';

export interface Payment {
  /** Hedera account id of the recipient — '0.0.xxxxx'. */
  recipient: string;
  /** Creator/affiliate code attributing the payment. */
  creatorCode: string;
  /** Order id this payout settles. */
  orderId: string;
  /** Tinybars. Use `hbarToTinybar()` when converting from human-readable HBAR. */
  amount: bigint;
  currency: Currency;
}

export interface PaymentRecord {
  payment: Payment;
  /** Unix epoch milliseconds — when the payment was decided + executed. */
  occurredAt: number;
  /** Hedera transaction id when the transfer landed on-chain; null when the engine blocked. */
  txId: string | null;
  decision: Decision['decision'];
}

export interface ConversionEvent {
  type: 'conversion';
  creatorCode: string;
  orderId: string;
  /** Tinybars — the commission the conversion entitles the creator to. */
  commission: bigint;
  /** Tinybars — the order value (for commission-rate computation). */
  orderValue: bigint;
  /** ISO timestamp. */
  verifiedAt: string;
  status: 'verified';
}

export interface PolicyState {
  /** Recent successful + escalated decisions; used by rolling-window + velocity rules. */
  recentPayments: PaymentRecord[];
  /** Order ids that have already been paid. Used by the idempotency rule. */
  paidOrderIds: Set<string>;
  /** Verified attribution events from the Conversions topic. */
  verifiedConversions: ConversionEvent[];
  /** Caller-supplied "now" — keeps the engine deterministic for tests. */
  now: number;
}

export type DecisionKind = 'allow' | 'block' | 'escalate';

export interface Decision {
  decision: DecisionKind;
  reasons: string[];
}

// ---------- rule config ----------

export interface PerTransactionCapConfig {
  /** Cap in tinybars. */
  amount: bigint;
}

export interface RollingWindowConfig {
  amount: bigint;
  windowHours: number;
}

export interface VelocityLimitConfig {
  maxPayments: number;
  windowHours: number;
}

export interface AllowlistConfig {
  /** Permitted recipients OR creator codes (prefixed: 'creator-code:ABC' or '0.0.1234'). */
  entries: string[];
}

export interface DenylistConfig {
  entries: string[];
}

export interface ApprovalThresholdConfig {
  amount: bigint;
}

export interface ConditionalGateConfig {
  requireVerifiedConversion: boolean;
  /** 0..1; e.g. 0.20 = 20%. The commission/orderValue ratio of the matched conversion
   * must be <= this value, or the rule blocks. */
  maxCommissionRate: number;
  /** Tinybars — allowed delta between requested amount and the matched conversion's
   * commission. Defaults to 0 (must match exactly). */
  amountTolerance?: bigint;
}

export interface RuleConfig {
  currency: Currency;
  perTransactionCap?: PerTransactionCapConfig;
  rollingWindow?: RollingWindowConfig;
  velocityLimit?: VelocityLimitConfig;
  allowlist?: AllowlistConfig;
  denylist?: DenylistConfig;
  approvalThreshold?: ApprovalThresholdConfig;
  conditionalGate?: ConditionalGateConfig;
  /** Always on; the rule schema exposes a toggle for tests + edge cases only. */
  idempotency?: { enabled: boolean };
}

// ---------- per-rule result ----------
// Each rule returns its own contribution; the aggregator combines them.

export interface RuleResult {
  rule: string;
  decision: DecisionKind;
  reason?: string;
}

export type Rule = (payment: Payment, state: PolicyState, config: RuleConfig) => RuleResult | null;

// ---------- helpers ----------

export const TINYBAR_PER_HBAR = 100_000_000n;

/** Convert human-readable HBAR (number or string, up to 8 decimal places) to tinybars. */
export function hbarToTinybar(hbar: number | string): bigint {
  const s = typeof hbar === 'number' ? hbar.toString() : hbar;
  const trimmed = s.trim();
  if (!/^-?\d+(\.\d{1,8})?$/.test(trimmed)) {
    throw new Error(`invalid HBAR amount: ${s}`);
  }
  const [whole, frac = ''] = trimmed.split('.');
  if (whole === undefined) throw new Error(`invalid HBAR amount: ${s}`);
  const negative = whole.startsWith('-');
  const wholePart = BigInt(negative ? whole.slice(1) : whole);
  const fracPadded = (frac + '00000000').slice(0, 8);
  const fracPart = BigInt(fracPadded);
  const result = wholePart * TINYBAR_PER_HBAR + fracPart;
  return negative ? -result : result;
}

/** Convert tinybars back to a human-readable HBAR string with no trailing zeros. */
export function tinybarToHbar(tinybar: bigint): string {
  const negative = tinybar < 0n;
  const abs = negative ? -tinybar : tinybar;
  const whole = abs / TINYBAR_PER_HBAR;
  const frac = abs % TINYBAR_PER_HBAR;
  let s = whole.toString();
  if (frac > 0n) {
    const fracStr = frac.toString().padStart(8, '0').replace(/0+$/, '');
    s += '.' + fracStr;
  }
  return negative ? '-' + s : s;
}
