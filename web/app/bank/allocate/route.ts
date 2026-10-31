// Record a payment from a bank receipt against an invoice (0052). See lib/bank-action.ts.
import { allocateReceiptAction } from '@/lib/bank-action';

export const POST = (request: Request) => allocateReceiptAction(request);
