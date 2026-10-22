// Create or edit a product (0040). See lib/catalog-action.ts.
import { saveProductAction } from '@/lib/catalog-action';

export const POST = (request: Request) => saveProductAction(request);
