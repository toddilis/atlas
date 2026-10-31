// Import a statement file into a bank account (0051). See lib/bank-action.ts.
import { importBankFileAction } from '@/lib/bank-action';

export const POST = (request: Request) => importBankFileAction(request);
