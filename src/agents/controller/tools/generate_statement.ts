// controller.generate_statement — snapshots an account's billing position for a period.
//
// Thin caller of the generate_statement_atomic RPC (migration 0015). The RPC does the
// real work: computes opening/closing balances, totals charges/payments in period,
// inserts a statements row + statement_lines in one transaction. This handler is the
// tool surface — registered for LLM-loop discovery; called from the operator-facing
// CLI / admin endpoint in Phase 2.
//
// Risk tier 'auto': statements are a read-projection + snapshot insert. No money moves
// (no ledger writes, no Stripe call, no email yet). Sending the statement to the
// customer arrives in a later PR with the email integration.

import { supabase, orgId } from '../../../data/supabase.js';
import { appendEvent } from '../../../platform/events/eventLog.js';
import type { ToolContext } from '../../../platform/tools/registry.js';

export interface GenerateStatementInput {
  accountId: string;
  /** Inclusive start of the statement period (ISO). */
  periodStartAt: string;
  /** Exclusive end of the statement period (ISO). Typically end of month. */
  asOfAt: string;
}

export interface GenerateStatementOutput {
  statementId: string;
  closingBalanceCents: number;
  lineCount: number;
}

export async function execute(
  input: GenerateStatementInput,
  ctx: ToolContext,
): Promise<GenerateStatementOutput> {
  const sb = supabase();
  const org = orgId();

  const { data, error } = await sb.rpc('generate_statement_atomic', {
    p_org_id: org,
    p_account_id: input.accountId,
    p_period_start_at: input.periodStartAt,
    p_as_of_at: input.asOfAt,
    p_generated_by: ctx.agentName,
  });
  if (error) throw error;
  const row = Array.isArray(data) ? data[0] : data;
  if (!row) throw new Error('generate_statement: rpc returned no row');

  await appendEvent({
    type: 'controller.statement.generated',
    source: 'controller',
    agentName: ctx.agentName,
    subjectType: 'statement',
    subjectId: row.statement_id as string,
    payload: {
      statement_id: row.statement_id,
      account_id: input.accountId,
      period_start_at: input.periodStartAt,
      as_of_at: input.asOfAt,
      closing_balance_cents: Number(row.closing_balance_cents),
      line_count: Number(row.line_count),
    },
    idempotencyKey: `controller.statement.generated:${row.statement_id}`,
  });

  return {
    statementId: row.statement_id as string,
    closingBalanceCents: Number(row.closing_balance_cents),
    lineCount: Number(row.line_count),
  };
}
