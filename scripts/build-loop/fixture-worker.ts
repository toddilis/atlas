import { executeFixture } from './fixture.js';
const [directory, runId, option, ...extra] = process.argv.slice(2);
if (!directory || !runId || !/^[a-f0-9]{64}$/.test(runId) || extra.length ||
    (option && option !== '--crash-after-release')) throw new Error('Invalid fixture worker arguments');
executeFixture(directory, runId, option === '--crash-after-release');
