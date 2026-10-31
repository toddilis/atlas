// Match a bank line to an invoice (0051). See lib/bank-action.ts.
import { matchBankLineAction } from '@/lib/bank-action';

export const POST = matchBankLineAction;
