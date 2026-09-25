import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { Coordinator, initialize, planSchema, type State } from './coordinator.js';
import { FixtureProvider, prepareFixture } from './fixture.js';

const [command, directoryArg, planFile, ...extra] = process.argv.slice(2);
if (!directoryArg || extra.length) throw new Error('Usage: cli.ts init|tick|run|status|pause|resume|revoke-release DIRECTORY [PLAN|--crash-after-submit]');
const directory = resolve(directoryArg);
const coordinator = new Coordinator(directory, new FixtureProvider(directory));
const summary = (state: State) => ({
  workflowId: state.workflowId, contractHash: state.contractHash, revision: state.revision,
  source: state.source, paused: state.paused, releaseAllowed: state.releaseAllowed,
  unitsReserved: state.unitsReserved, limits: state.plan.limits,
  tasks: state.tasks, runs: state.runs,
});
if (command === 'init') {
  if (!planFile) throw new Error('init requires an accepted fixture plan');
  const plan = planSchema.parse(JSON.parse(readFileSync(planFile, 'utf8')));
  if (existsSync(join(directory, 'state', '0000000000.json'))) throw new Error('Run already initialized');
  const baseCommit = prepareFixture(directory);
  initialize(directory, plan, baseCommit);
} else if (command === 'tick') {
  if (planFile && planFile !== '--crash-after-submit') throw new Error('Unknown tick option');
  await coordinator.tick(Date.now(), planFile === '--crash-after-submit');
} else if (command === 'run') {
  if (planFile) throw new Error('run takes no options; limits are in the accepted plan');
  for (let ticks = 0; ticks < 1000; ticks++) {
    const before = coordinator.journal.read();
    const after = await coordinator.tick();
    if (after.tasks.every((task) => task.status === 'done') || after.paused) break;
    const pending = after.tasks.some((task) => task.status === 'running');
    if (before.revision === after.revision && !pending) break;
    if (ticks === 999) throw new Error('Wake-up tick limit reached; inspect status and resume the same directory');
    await setTimeout(25);
  }
} else if (command === 'pause' || command === 'resume' || command === 'revoke-release') {
  if (planFile) throw new Error('Control commands take no extra arguments');
  coordinator.control(command);
} else if (command !== 'status' || planFile) {
  throw new Error('Unknown command or extra argument');
}
console.log(JSON.stringify(summary(coordinator.journal.read()), null, 2));
