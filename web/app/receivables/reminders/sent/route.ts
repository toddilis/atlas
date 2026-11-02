// Record that a payment reminder was sent (0053). See lib/reminder-action.ts.
import { recordReminderSentAction } from '@/lib/reminder-action';

export const POST = (request: Request) => recordReminderSentAction(request);
