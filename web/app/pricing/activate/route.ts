// Activate the latest saved pricing version after a matching preview (0033). See lib/pricing-action.ts.
import { activatePricing } from '@/lib/pricing-action';

export const POST = (request: Request) => activatePricing(request);
