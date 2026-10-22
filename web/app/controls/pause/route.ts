// Pause or resume business actions (0041). See lib/controls-action.ts.
import { setPauseAction } from '@/lib/controls-action';

export const POST = (request: Request) => setPauseAction(request);
