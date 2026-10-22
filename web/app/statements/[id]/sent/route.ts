// Record that this statement was sent to the customer (0047). See lib/statement-action.ts.
import { recordStatementSentAction } from '@/lib/statement-action';

export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }) =>
  recordStatementSentAction(request, (await params).id);
