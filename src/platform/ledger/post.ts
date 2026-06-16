// Ledger posting — Phase 1 PR-C. Two automatic strategies (invoice_issued,
// payment_received) live inside Postgres functions in migration 0012 because they need
// to share a transaction with the originating write (invoice state transition / payment
// insert). This module exposes types for callers + a manual-adjustment helper for ad-hoc
// posts that don't ride an existing transactional path.
//
// Chart of accounts (per 0009_seed_chart):
//   1000  Cash                       (asset)
//   1100  Accounts Receivable        (asset)
//   1110  Stripe Clearing            (asset)
//   1120  Shopify Payments Clearing  (asset)        — reserved for DTC
//   1300  Consignment Inventory      (asset)        — reserved for consignment
//   2200  Sales Tax Payable          (liability)
//   4000  Revenue — Wholesale        (revenue)
//   4100  Revenue — DTC              (revenue)      — reserved
//   4200  Revenue — Consignment      (revenue)      — reserved
//
// Strategy summary:
//   invoice_issued (wholesale)    →   +1100 AR, -4000 Revenue (net), -2200 Tax (if any)
//   payment_received (wholesale)  →   +1110 Stripe Clearing, -1100 AR
//
// The double-entry invariant (sum of lines = 0 per transaction) is enforced by the
// deferred trigger `ledger_balance_check` in migration 0004_ledger.sql, so a TS caller
// that constructs an unbalanced post will get a DB error at commit time.

import { supabase, orgId } from '../../data/supabase.js';
import type { LedgerSource, BillingChannel } from './types.js';

export interface LedgerLine {
  /** Chart-of-accounts code (e.g. '1100'). Resolved to ledger_accounts.id at post time. */
  accountCode: string;
  /** Signed minor units. Positive = debit, negative = credit. Lines per txn must sum to 0. */
  amountCents: number;
  currency: string;
  memo?: string;
}

export interface ManualLedgerPost {
  channel: BillingChannel;
  source: LedgerSource;
  sourceRef?: string | null;
  sourceRefType?: string | null;
  description?: string;
  occurredAt: Date;
  postedByAgent?: string | null;
  lines: LedgerLine[];
}

/**
 * Post a manual / one-off ledger transaction. Used for adjustments and back-office posts
 * that don't go through the automatic invoice/payment strategies. The DB trigger enforces
 * sum-to-zero; this function does NOT pre-validate, so an unbalanced input will surface
 * as a `ledger imbalance: ...` exception from Postgres.
 *
 * For automatic posts on invoice issuance + payment receipt, use the RPCs
 * `issue_invoice_atomic` and `post_payment_received` instead — they post the ledger
 * inside the same DB transaction as the originating write.
 */
export async function postManualLedger(input: ManualLedgerPost): Promise<string> {
  const sb = supabase();
  const org = orgId();

  // Resolve codes → account ids in one query.
  const codes = Array.from(new Set(input.lines.map((l) => l.accountCode)));
  const { data: accounts, error: lookupErr } = await sb
    .from('ledger_accounts')
    .select('id, code')
    .eq('org_id', org)
    .eq('active', true)
    .in('code', codes);
  if (lookupErr) throw lookupErr;
  const idByCode = new Map<string, string>(
    (accounts ?? []).map((r) => [r.code as string, r.id as string]),
  );
  for (const code of codes) {
    if (!idByCode.has(code)) {
      throw new Error(`ledger account code ${code} not found for org ${org}`);
    }
  }

  const { data: txn, error: txnErr } = await sb
    .from('ledger_transactions')
    .insert({
      org_id: org,
      channel: input.channel,
      source: input.source,
      source_ref: input.sourceRef ?? null,
      source_ref_type: input.sourceRefType ?? null,
      description: input.description ?? null,
      occurred_at: input.occurredAt.toISOString(),
      posted_by_agent: input.postedByAgent ?? null,
    })
    .select('id')
    .single();
  if (txnErr) throw txnErr;

  const lineRows = input.lines.map((l) => ({
    org_id: org,
    transaction_id: txn.id as string,
    ledger_account_id: idByCode.get(l.accountCode)!,
    amount_cents: l.amountCents,
    currency: l.currency,
    memo: l.memo ?? null,
  }));
  const { error: lineErr } = await sb.from('ledger_lines').insert(lineRows);
  if (lineErr) throw lineErr;

  return txn.id as string;
}
