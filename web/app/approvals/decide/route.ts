// Decide a pending bound approval (0037). See lib/approval-action.ts.
import { decideApprovalAction } from '@/lib/approval-action';

export const POST = (request: Request) => decideApprovalAction(request);
