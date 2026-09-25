import { executeFixture } from './fixture.js';
const [directory, runId] = process.argv.slice(2);
if (!directory || !runId || !/^[a-f0-9]{64}$/.test(runId)) throw new Error('Invalid fixture worker arguments');
executeFixture(directory, runId);
