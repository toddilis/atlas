// Save the business profile (0045). See lib/profile-action.ts.
import { saveProfileAction } from '@/lib/profile-action';

export const POST = (request: Request) => saveProfileAction(request);
