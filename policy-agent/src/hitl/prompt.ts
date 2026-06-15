// HITL prompt — minimal readline-based yes/no confirmation. Used by the wrapped payment
// tool when the policy engine returns `escalate`. Returns true iff the operator typed a
// confirming response. The function is injectable so tests can pass a fake.

import { createInterface } from 'node:readline/promises';

export type Confirm = (question: string) => Promise<boolean>;

/** Default implementation: reads one line from stdin and accepts y / yes / 1 (case-insensitive). */
export const cliConfirm: Confirm = async (question: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes' || answer === '1';
  } finally {
    rl.close();
  }
};
