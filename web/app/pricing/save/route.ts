// Save a pricing draft as a new version (0033). See lib/pricing-action.ts.
import { savePricing } from '@/lib/pricing-action';

export const POST = (request: Request) => savePricing(request);
