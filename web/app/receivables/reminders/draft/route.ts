// Draft a payment reminder from the stored records (0053). See lib/reminder-action.ts.
import { draftReminderAction } from '@/lib/reminder-action';

export const POST = (request: Request) => draftReminderAction(request);
