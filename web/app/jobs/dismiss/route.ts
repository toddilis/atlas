// Dismiss a blocked or quarantined job that will never succeed (0031). See lib/job-action.ts.
import { jobAction } from '@/lib/job-action';

export const POST = (request: Request) => jobAction(request, 'dismiss_scheduled_job', 'dismissed');
