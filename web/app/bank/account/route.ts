// Add or edit a bank account (0051). See lib/bank-action.ts.
import { saveBankAccountAction } from '@/lib/bank-action';

export const POST = (request: Request) => saveBankAccountAction(request);
