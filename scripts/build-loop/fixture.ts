// Harmless local provider. No model, network, merge, deployment or live adapter.
// Each role runs in a fresh subprocess with an allowlisted environment.
import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Provider, Receipt, Run, State, Task } from './coordinator.js';
import { Journal, publish, readIfPresent } from './store.js';

const execute = promisify(execFile);
const worker = fileURLToPath(new URL('./fixture-worker.ts', import.meta.url));
export function workerEnvironment(): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[name]) result[name] = process.env[name];
  }
  return { ...result, GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
    GIT_AUTHOR_NAME: 'Atlas Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
    GIT_COMMITTER_NAME: 'Atlas Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid',
    GIT_AUTHOR_DATE: '2026-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2026-01-01T00:00:00Z' };
}
export function fixtureGit(directory: string, args: string[], input?: string, raw = false): string {
  const gitDirectory = join(directory, 'provider', 'git');
  const output = execFileSync('git', ['-c', `safe.directory=${gitDirectory}`, `--git-dir=${gitDirectory}`, ...args],
    { encoding: 'utf8', input, env: workerEnvironment(), windowsHide: true, timeout: 10000 });
  return raw ? output : output.trimEnd();
}
export function prepareFixture(directory: string): string {
  mkdirSync(join(directory, 'provider', 'receipts'), { recursive: true });
  mkdirSync(join(directory, 'provider', 'releases'), { recursive: true });
  execFileSync('git', ['init', '--bare', join(directory, 'provider', 'git')],
    { env: workerEnvironment(), windowsHide: true, stdio: 'pipe', timeout: 10000 });
  const tree = fixtureGit(directory, ['mktree'], '');
  const base = fixtureGit(directory, ['commit-tree', tree], 'Atlas fixture baseline\n');
  fixtureGit(directory, ['update-ref', 'refs/heads/fixture', base]);
  return base;
}

export class FixtureProvider implements Provider {
  constructor(readonly directory: string) {}
  receipt(run: Run): Receipt | undefined {
    return readIfPresent(join(this.directory, 'provider', 'receipts', `${run.id}.json`));
  }
  async submit(state: State, run: Run): Promise<void> {
    if (this.receipt(run)) return;
    // Only the fixed worker is executable. Task prose is never a command.
    await execute(process.execPath, ['--import', 'tsx', worker, resolve(this.directory), run.id], {
      env: workerEnvironment(), windowsHide: true,
      timeout: Math.max(1, run.deadline - Date.now()), maxBuffer: 1024 * 1024,
    });
  }
}

export function candidateFor(directory: string, task: Task, attempt: number, value = task.value): string {
  const baseCommit = new Journal<State>(join(directory, 'state')).read().source.baseCommit;
  const blob = fixtureGit(directory, ['hash-object', '-w', '--stdin'], value + '\n');
  const tree = fixtureGit(directory, ['mktree'], `100644 blob ${blob}\tanswer.txt\n`);
  return fixtureGit(directory, ['commit-tree', tree, '-p', baseCommit], `Fixture ${task.id}, attempt ${attempt}\n`);
}

function claimWorker(directory: string, runId: string): boolean {
  const claims = join(directory, 'provider', 'claims', runId);
  mkdirSync(claims, { recursive: true });
  for (let retry = 0; retry < 100; retry++) {
    const latest = readdirSync(claims).filter((name) => /^\d{10}\.json$/.test(name)).sort().at(-1);
    if (latest) {
      const owner = readIfPresent<{ pid: number }>(join(claims, latest))!;
      try { process.kill(owner.pid, 0); return false; }
      catch (error) {
        // Only proven process exit allows recovery; permission errors fail closed.
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    const generation = latest ? Number(latest.slice(0, 10)) + 1 : 0;
    if (publish(join(claims, `${generation}`.padStart(10, '0') + '.json'), { pid: process.pid })) return true;
  }
  throw new Error('Fixture worker claim contention');
}

// Called only by the fixed fixture worker, with the accepted plan read from the
// trusted journal. The build output cannot supply verification/release receipts.
export function executeFixture(directory: string, runId: string): void {
  const state = new Journal<State>(join(directory, 'state')).read();
  const run = state.runs.find((item) => item.id === runId);
  if (!run) throw new Error('Unrecognized run');
  const receiptFile = join(directory, 'provider', 'receipts', `${run.id}.json`);
  if (readIfPresent(receiptFile)) return;
  if (!claimWorker(directory, run.id)) return;
  // A previous owner may have published its result immediately before exiting.
  if (readIfPresent(receiptFile)) return;
  const taskState = state.tasks.find((item) => item.activeRunId === run.id);
  if (!taskState || state.paused || run.status !== 'pending') return;
  const task = state.plan.tasks.find((item) => item.id === run.taskId)!;
  let candidate = run.candidate;
  let ok = true;
  let detail: string;
  if (run.stage === 'build') {
    ok = run.attempt > task.failBuildAttempts;
    if (ok) candidate = candidateFor(directory, task, run.attempt);
    detail = ok ? 'Built answer.txt as a real immutable Git commit' : 'Configured fixture build failure';
  } else if (run.stage === 'verify') {
    ok = fixtureGit(directory, ['show', `${candidate}:answer.txt`], undefined, true) === task.value + '\n';
    detail = ok ? 'Verified committed answer against accepted fixture contract' : 'Fixture value mismatch';
  } else if (run.stage === 'review') {
    const tree = fixtureGit(directory, ['ls-tree', '-r', candidate!]);
    const lineage = fixtureGit(directory, ['rev-list', '--parents', '-n', '1', candidate!]);
    ok = /^100644 blob [a-f0-9]{40}\tanswer\.txt$/.test(tree) &&
      lineage === `${candidate} ${state.source.baseCommit}`;
    detail = ok ? 'Separate review: only the permitted non-executable fixture file exists' : 'Unexpected candidate tree';
  } else {
    const current = new Journal<State>(join(directory, 'state')).read();
    const currentTask = current.tasks.find((item) => item.id === task.id)!;
    const evidence = ['verify', 'review'].every((stage) => current.runs.some((item) =>
      item.id === currentTask.evidence[stage as 'verify' | 'review'] && item.status === 'succeeded' &&
      item.candidate === candidate && item.epoch === run.epoch));
    ok = current.releaseAllowed && !current.paused && evidence && currentTask.activeRunId === run.id;
    if (ok) publish(join(directory, 'provider', 'releases', `${run.id}.json`), {
      candidate, runId, taskId: task.id, kind: 'fixture-only',
    });
    detail = ok ? 'Recorded one idempotent fixture release receipt; no external release' : 'Release authority or evidence missing';
  }
  const receipt: Receipt = {
    runId, taskId: task.id, attempt: run.attempt, epoch: run.epoch, stage: run.stage,
    candidate, ok, detail, externalRunId: `fixture-run:${run.id}`,
    pullRequestId: `fixture-pr:${state.workflowId}/${task.id}`,
  };
  publish(receiptFile, receipt);
}
