// Mark a bank line as not a customer receipt, or reopen it (0052). See lib/bank-action.ts.
import { reviewBankLineAction } from '@/lib/bank-action';

export const POST = (request: Request) => reviewBankLineAction(request);
