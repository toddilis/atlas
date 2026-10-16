// Record a carrier cost by hand for a dismissed job (0032). See lib/job-action.ts.
import { jobAction } from '@/lib/job-action';

export const POST = (request: Request) => jobAction(request, 'record_manual_carrier_cost', 'cost_recorded');
