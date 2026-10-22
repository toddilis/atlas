// Generate a retailer statement (0044). See lib/statement-action.ts.
import { generateStatementAction } from '@/lib/statement-action';

export const POST = (request: Request) => generateStatementAction(request);
