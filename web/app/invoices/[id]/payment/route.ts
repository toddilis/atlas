// Record a bank payment against this invoice (0043). See lib/invoice-action.ts.
import { recordPayment } from '@/lib/invoice-action';

export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }) =>
  recordPayment(request, (await params).id);
