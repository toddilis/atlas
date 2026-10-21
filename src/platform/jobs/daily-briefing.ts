import { generateDailyBriefing } from '../assistant/briefing.js';
import { messageOf, runJobPass, scheduledJobs, type JobsStore } from './store.js';

// JOBS-01 runner for the daily briefing (0038). The database decides whether narration is
// wanted at all — the business's assistant.narrate grant is the model-spend switch and is
// never seeded — and this loop runs at most one grounded narration per claim. A narration
// that fails the grounding check is stored as rejected with its reason and blocks the job:
// a person decides whether to retry spending on it. Outages and rate limits retry.

export type { JobsStore } from './store.js';
export type BriefingGenerator = (orgId: string) => Promise<{ status: string; briefingId: string; model: string }>;

const NEEDS_A_PERSON = [/^ANTHROPIC_API_KEY/, /briefing rejected:/, /authentication|invalid x-api-key|permission/i,
  /credit balance|billing/i, /refusal/];
export function classifyDailyBriefing(error: unknown): 'retry' | 'blocked' {
  const message = messageOf(error);
  return NEEDS_A_PERSON.some(p => p.test(message)) ? 'blocked' : 'retry';
}

/** The narration runs only on a worker that holds the key; the business's grant is checked
 * in the database by discovery and claim. */
export const narrationEnabled = (env: Record<string, string | undefined> = process.env) => Boolean(env.ANTHROPIC_API_KEY?.trim());

export const dailyBriefingJobs: JobsStore = scheduledJobs('daily_briefing');

export async function runDailyBriefingJobs(orgId: string, options: { limit?: number; store?: JobsStore; generate?: BriefingGenerator } = {}) {
  const generate = options.generate ?? generateDailyBriefing;
  return runJobPass(orgId, options.store ?? dailyBriefingJobs, async job => {
    const result = await generate(job.org_id ?? orgId);
    return { briefing_id: result.briefingId, model: result.model, status: result.status };
  }, classifyDailyBriefing, options.limit ?? 1);
}
