// Void a draft payment reminder (0053). See lib/reminder-action.ts.
import { voidReminderAction } from '@/lib/reminder-action';

export const POST = (request: Request) => voidReminderAction(request);
