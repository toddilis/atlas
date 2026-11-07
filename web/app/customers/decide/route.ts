// Decide who a Shopify customer is (0054). See lib/customer-action.ts.
import { decideCustomerAction } from '@/lib/customer-action';

export const POST = (request: Request) => decideCustomerAction(request);
