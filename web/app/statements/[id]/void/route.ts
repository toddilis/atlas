// Void this statement with a reason (0047). See lib/statement-action.ts.
import { voidStatementAction } from '@/lib/statement-action';

export const POST = async (request: Request, { params }: { params: Promise<{ id: string }> }) =>
  voidStatementAction(request, (await params).id);
