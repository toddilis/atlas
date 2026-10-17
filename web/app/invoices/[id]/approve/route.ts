// Approve and issue the exact invoice part the page showed (0034). See lib/invoice-action.ts.
import { approveInvoice } from '@/lib/invoice-action';

export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }) =>
  approveInvoice(request, (await params).id);
