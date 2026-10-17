// Record what happened to the printed document: printed, or failed with a note (0034).
import { recordPrint } from '@/lib/invoice-action';

export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }) =>
  recordPrint(request, (await params).id);
