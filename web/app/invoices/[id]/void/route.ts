// Void this issued invoice with a reason (0048). See lib/invoice-action.ts.
import { voidInvoice } from '@/lib/invoice-action';

export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }) =>
  voidInvoice(request, (await params).id);
