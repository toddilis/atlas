// Single-host immutable snapshots. Publishing the next generation with link()
// is an atomic compare-and-swap: a competing writer cannot replace that file.
// No expiring filesystem lock can be stolen from a paused but still-live process.
import { closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync,
  readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

export function publish(file: string, value: unknown): boolean {
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify(value) + '\n');
    fsyncSync(fd);
  } finally { closeSync(fd); }
  try {
    linkSync(temporary, file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  } finally { unlinkSync(temporary); }
}

export class Journal<T extends { revision: number }> {
  constructor(readonly directory: string) { mkdirSync(directory, { recursive: true }); }

  read(): T {
    const revisions = readdirSync(this.directory)
      .filter((name) => /^\d{10}\.json$/.test(name)).sort();
    const latest = revisions.at(-1);
    if (!latest) throw new Error('Run is not initialized');
    return JSON.parse(readFileSync(join(this.directory, latest), 'utf8')) as T;
  }

  initialize(state: T): void {
    if (state.revision !== 0) throw new Error('Initial revision must be zero');
    if (!publish(join(this.directory, '0000000000.json'), state)) {
      throw new Error('Run already initialized; use the existing run identity');
    }
  }

  update(change: (state: T) => boolean): T {
    for (let attempt = 0; attempt < 100; attempt++) {
      const state = this.read();
      if (!change(state)) return state;
      state.revision++;
      const file = join(this.directory, `${state.revision}`.padStart(10, '0') + '.json');
      if (publish(file, state)) return state;
    }
    throw new Error('Too much concurrent state contention; retry this wake-up');
  }
}

export function readIfPresent<T>(file: string): T | undefined {
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) as T : undefined;
}
