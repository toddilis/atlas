// Ask the read-only assistant (0039). See lib/assistant-action.ts.
import { askAssistantAction } from '@/lib/assistant-action';

export const POST = (request: Request) => askAssistantAction(request);
