// Retry a blocked, quarantined or dismissed job (0030/0031). See lib/job-action.ts.
import { jobAction } from '@/lib/job-action';

export const POST = (request: Request) => jobAction(request, 'retry_scheduled_job', 'retried');
