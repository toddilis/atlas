// Connect or edit the Shopify connection (0042). See lib/connections-action.ts.
import { saveConnectionAction } from '@/lib/connections-action';

export const POST = (request: Request) => saveConnectionAction(request);
