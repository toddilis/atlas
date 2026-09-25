import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { z } from 'zod';
import { Journal } from './store.js';

const sha = z.string().regex(/^[a-f0-9]{40}$/);
const id = z.string().regex(/^[A-Z][A-Z0-9-]{0,63}$/);
const taskSchema = z.object({
  id, dependsOn: z.array(id), instruction: z.string().max(4000),
  // Declarative fixture input, never shell/model instructions.
  value: z.string().max(1000), failBuildAttempts: z.number().int().min(0).max(10).default(0),
}).strict();
export const planSchema = z.object({
  mode: z.literal('fixture'),
  limits: z.object({
    maxTasks: z.number().int().min(1).max(100),
    maxAttempts: z.number().int().min(1).max(10),
    maxUnits: z.number().int().min(0).max(10000),
    maxConcurrent: z.literal(1),
    runTimeoutMs: z.number().int().min(100).max(3600000),
  }).strict(),
  allowFixtureRelease: z.boolean(),
  tasks: z.array(taskSchema).min(1).max(100),
}).strict().superRefine((plan, context) => {
  const seen = new Set<string>();
  for (const task of plan.tasks) {
    if (seen.has(task.id) || task.dependsOn.some((dependency) => !seen.has(dependency))) {
      context.addIssue({ code: z.ZodIssueCode.custom,
        message: 'Task IDs must be unique and dependencies must precede their task' });
    }
    seen.add(task.id);
  }
});
export type Plan = z.infer<typeof planSchema>;
export type Task = Plan['tasks'][number];
export const stages = ['build', 'verify', 'review', 'release'] as const;
export type Stage = typeof stages[number];
export interface Run {
  id: string; taskId: string; attempt: number; epoch: number; stage: Stage;
  candidate?: string; createdAt: number; deadline: number;
  status: 'pending' | 'succeeded' | 'failed' | 'superseded';
  receipt?: Receipt;
}
const receiptSchema = z.object({
  runId: z.string(), taskId: id, stage: z.enum(stages), attempt: z.number().int(),
  epoch: z.number().int(), candidate: sha.optional(), ok: z.boolean(),
  externalRunId: z.string().min(1), pullRequestId: z.string().min(1),
  detail: z.string().max(4000),
}).strict();
export type Receipt = z.infer<typeof receiptSchema>;
export interface TaskState {
  id: string; status: 'ready' | 'running' | 'blocked' | 'done';
  attempt: number; epoch: number; stage: Stage; candidate?: string;
  activeRunId?: string; reason?: string;
  evidence: Partial<Record<Stage, string>>;
  lease?: { id: string; claimedAt: number; heartbeatAt: number };
}
export interface State {
  revision: number; workflowId: string; contractHash: string; plan: Plan;
  source: { repository: string; branch: string; baseCommit: string };
  paused: boolean; releaseAllowed: boolean; unitsReserved: number;
  tasks: TaskState[]; runs: Run[];
}
export interface Provider {
  // Idempotent by run.id, including concurrent submit and crash-after-submit.
  // A production adapter MUST reconcile that identity before another dispatch.
  submit(state: State, run: Run): Promise<void>;
  receipt(run: Run): unknown | undefined;
}

export function initialize(directory: string, input: unknown, baseCommit: string): State {
  const plan = planSchema.parse(input);
  sha.parse(baseCommit);
  const workflowId = randomUUID();
  const state: State = {
    revision: 0, workflowId, plan,
    source: { repository: `fixture:${workflowId}`, branch: 'fixture', baseCommit },
    contractHash: createHash('sha256').update(JSON.stringify(plan)).digest('hex'),
    paused: false, releaseAllowed: plan.allowFixtureRelease, unitsReserved: 0,
    tasks: plan.tasks.map((task) => ({ id: task.id, status: 'ready', attempt: 0,
      epoch: 0, stage: 'build', evidence: {} })), runs: [],
  };
  new Journal<State>(join(directory, 'state')).initialize(state);
  return state;
}

export class Coordinator {
  readonly journal: Journal<State>;
  constructor(directory: string, readonly provider: Provider) {
    this.journal = new Journal(join(directory, 'state'));
  }

  control(command: 'pause' | 'resume' | 'revoke-release'): State {
    return this.journal.update((state) => {
      if (command === 'revoke-release') state.releaseAllowed = false;
      else state.paused = command === 'pause';
      return true;
    });
  }

  // Trusted source observation, not a builder-authored approval. A new head
  // discards old checks and review and gets new stage identities. Never change
  // the subject of an already-dispatched release; reconcile it first.
  observeCandidate(taskId: string, candidate: string): State {
    sha.parse(candidate);
    return this.journal.update((state) => {
      const task = state.tasks.find((item) => item.id === taskId);
      if (!task || task.status !== 'running' || !task.candidate || task.stage === 'release') {
        throw new Error('Candidate observation requires an active pre-release candidate');
      }
      if (task.candidate === candidate) return false;
      const active = state.runs.find((run) => run.id === task.activeRunId);
      if (active) active.status = 'superseded';
      task.candidate = candidate;
      task.epoch++;
      task.evidence = {};
      task.stage = 'verify';
      delete task.activeRunId;
      return true;
    });
  }

  private accept(runId: string, input: unknown): void {
    const parsed = receiptSchema.safeParse(input);
    this.journal.update((state) => {
      const run = state.runs.find((item) => item.id === runId);
      const task = state.tasks.find((item) => item.activeRunId === runId);
      if (!run || !task || run.status !== 'pending') return false;
      const result = parsed.success ? parsed.data : undefined;
      if (!result || result.runId !== run.id || result.taskId !== run.taskId ||
          result.stage !== run.stage || result.attempt !== run.attempt || result.epoch !== run.epoch ||
          (run.stage !== 'build' && result.candidate !== run.candidate) ||
          (run.stage === 'build' && result.ok && !result.candidate)) {
        const reason = 'Receipt identity, role or candidate did not match the dispatched run';
        if (task.status === 'blocked' && task.reason === reason) return false;
        task.status = 'blocked';
        task.reason = reason;
        return true;
      }
      run.receipt = result;
      run.status = result.ok ? 'succeeded' : 'failed';
      delete task.activeRunId;
      // A late authoritative receipt resolves the uncertainty without a new
      // job identity. Global pause/revocation are still checked before dispatch.
      task.status = 'running';
      delete task.reason;
      if (!result.ok) {
        if (run.stage === 'release') {
          task.status = 'blocked';
          task.reason = 'Release failed; reconcile its external identity before operator-authorized recovery';
        } else if (task.attempt < state.plan.limits.maxAttempts) {
          task.stage = 'build';
          task.attempt++;
          task.epoch++;
          delete task.candidate;
          task.evidence = {};
        } else {
          task.status = 'blocked';
          task.reason = `Repair attempts exhausted: ${result.detail}`;
        }
        return true;
      }
      if (run.stage === 'build') task.candidate = result.candidate;
      task.evidence[run.stage] = run.id;
      if (run.stage === 'release') task.status = 'done';
      else task.stage = stages[stages.indexOf(run.stage) + 1]!;
      return true;
    });
  }

  async tick(now = Date.now(), crashAfterSubmit = false): Promise<State> {
    // Poll/reconcile persisted run IDs even while paused or blocked. Wake-ups
    // carry no outcome/authority; only the provider's bound receipt can advance.
    for (const run of this.journal.read().runs.filter((item) => item.status === 'pending')) {
      const receipt = this.provider.receipt(run);
      if (receipt !== undefined) this.accept(run.id, receipt);
    }
    const state = this.journal.update((state) => {
      if (state.paused) return false;
      let task = state.tasks.find((item) => item.status === 'running');
      if (!task) {
        // A timed-out/invalid receipt is uncertain work, not free concurrency.
        if (state.runs.some((run) => run.status === 'pending')) return false;
        task = state.tasks.find((item) => item.status === 'ready' &&
          state.plan.tasks.find((spec) => spec.id === item.id)!.dependsOn.every((id) =>
            state.tasks.find((parent) => parent.id === id)!.status === 'done'));
        if (!task) return false;
        if (state.tasks.filter((item) => item.lease).length >= state.plan.limits.maxTasks) {
          task.status = 'blocked'; task.reason = 'Configured task limit reached'; return true;
        }
        task.status = 'running'; task.attempt = 1;
        task.lease = { id: `${state.workflowId}/${task.id}`, claimedAt: now, heartbeatAt: now };
      }
      if (task.activeRunId) {
        const run = state.runs.find((item) => item.id === task!.activeRunId)!;
        if (run.stage === 'release' && !state.releaseAllowed) {
          task.status = 'blocked';
          task.reason = `Release authority revoked; reconcile reserved run ${run.id}`;
          return true;
        }
        if (now > run.deadline) {
          task.status = 'blocked';
          task.reason = `Run deadline exceeded; reconcile ${run.id} before retrying`;
          return true;
        }
        return false;
      }
      if (task.stage === 'release') {
        const validEvidence = (stage: Stage) => state.runs.some((run) =>
          run.id === task!.evidence[stage] && run.status === 'succeeded' &&
          run.candidate === task!.candidate && run.epoch === task!.epoch);
        if (!state.releaseAllowed || !validEvidence('verify') || !validEvidence('review')) {
          task.status = 'blocked'; task.reason = 'Release authority or current-candidate evidence is missing';
          return true;
        }
      }
      if (state.unitsReserved >= state.plan.limits.maxUnits) {
        task.status = 'blocked'; task.reason = 'Fixture unit budget exhausted'; return true;
      }
      const run: Run = {
        id: createHash('sha256').update(`${state.workflowId}/${task.id}/${task.attempt}/${task.epoch}/${task.stage}`).digest('hex'),
        taskId: task.id, attempt: task.attempt, epoch: task.epoch, stage: task.stage,
        candidate: task.candidate, createdAt: now, deadline: now + state.plan.limits.runTimeoutMs,
        status: 'pending',
      };
      state.runs.push(run);
      state.unitsReserved++; // Reserve before dispatch. Uncertain work is never refunded.
      task.activeRunId = run.id;
      task.lease!.heartbeatAt = now;
      return true;
    });
    if (!state.paused) {
      for (const task of state.tasks.filter((item) => item.status === 'running')) {
        const run = state.runs.find((item) => item.id === task.activeRunId);
        if (!run || run.status !== 'pending') continue;
        // Re-read authority after claiming and before external submission.
        const current = this.journal.read();
        if (current.paused || (run.stage === 'release' && !current.releaseAllowed) ||
            !current.tasks.some((item) => item.activeRunId === run.id && item.status === 'running')) continue;
        try {
          await this.provider.submit(current, run);
        } catch (error) {
          this.journal.update((latest) => {
            const subject = latest.tasks.find((item) => item.activeRunId === run.id);
            if (!subject) return false;
            subject.status = 'blocked';
            subject.reason = `Submission uncertain for ${run.id}: ${String(error).slice(0, 500)}; reconcile before retry`;
            return true;
          });
          continue;
        }
        if (crashAfterSubmit) process.exit(86); // Fixture-only crash drill at the external handoff.
        const receipt = this.provider.receipt(run);
        if (receipt !== undefined) this.accept(run.id, receipt);
      }
    }
    return this.journal.read();
  }
}
