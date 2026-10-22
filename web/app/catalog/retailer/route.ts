// Create or edit a retailer (0040). See lib/catalog-action.ts.
import { saveRetailerAction } from '@/lib/catalog-action';

export const POST = (request: Request) => saveRetailerAction(request);
