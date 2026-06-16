// Ledger type aliases — these mirror the Postgres enums in 0003_billing.sql and
// 0004_ledger.sql. Kept in a separate file so consumers don't drag in the supabase
// client just to type a memo.

export type LedgerSource =
  | 'invoice_issued'
  | 'invoice_voided'
  | 'payment_received'
  | 'payment_refunded'
  | 'payout_received'
  | 'manual_adjustment';

export type BillingChannel = 'wholesale' | 'consignment' | 'dtc' | 'internal';

export type LedgerAccountType =
  | 'asset'
  | 'liability'
  | 'equity'
  | 'revenue'
  | 'expense';
