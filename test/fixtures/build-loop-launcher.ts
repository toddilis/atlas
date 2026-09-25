// Acceptance helper: the initiating process exits while the fixed, bounded
// fixture dispatcher remains alive. No shell, live API or user credentials.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { workerEnvironment } from '../../scripts/build-loop/fixture.js';
const directory = process.argv[2];
if (!directory) throw new Error('Missing fixture directory');
const cli = fileURLToPath(new URL('../../scripts/build-loop/cli.ts', import.meta.url));
const child = spawn(process.execPath, ['--import', 'tsx', cli, 'run', directory], {
  env: workerEnvironment(), detached: true, stdio: 'ignore', windowsHide: true,
});
child.unref();
console.log(child.pid);
