// Interception test — proves the structural safety property: the ONLY file in the
// codebase that imports `transferHbar` from src/hedera/transfer.ts is the wrapped
// payment tool (src/agent/tools/payCreator.ts). If any other path imports it, this
// test fails. That guarantees a `block` decision can never reach the chain — there is
// no in-band caller of the transfer function outside the wrapper.
//
// Also: the wrapped payment tool itself must contain a call to `evaluate(` before its
// `transferHbar(` call. We assert ordering by line number on the source text.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

// fileURLToPath gives the correct OS-native path on both POSIX and Windows;
// .pathname produces `/C:/...` on Windows which then double-prefixes when joined.
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const SRC = join(ROOT, 'src');
const WRAPPED = join(SRC, 'agent/tools/payCreator.ts');

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const st = statSync(path);
    if (st.isDirectory()) out.push(...walk(path));
    else if (path.endsWith('.ts')) out.push(path);
  }
  return out;
}

function stripLineComments(body: string): string {
  return body
    .split('\n')
    .map((line) => (line.trimStart().startsWith('//') ? '' : line))
    .join('\n');
}

test('only payCreator.ts imports transferHbar', () => {
  const offenders: string[] = [];
  for (const file of walk(SRC)) {
    if (file === WRAPPED) continue;
    if (basename(file) === 'transfer.ts') continue;   // the source file itself
    const body = stripLineComments(readFileSync(file, 'utf8'));
    // Match `from '...transfer.js'` or `transferHbar` referenced anywhere in code.
    if (/from\s+['"][^'"]*\/transfer\.js['"]/.test(body) || /\btransferHbar\b/.test(body)) {
      offenders.push(relative(ROOT, file));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `expected only payCreator.ts to import transferHbar; offenders: ${offenders.join(', ')}`,
  );
});

test('payCreator.ts calls evaluate() before transferHbar()', () => {
  const body = stripLineComments(readFileSync(WRAPPED, 'utf8'));
  const evaluateIdx = body.indexOf('evaluate(');
  const transferIdx = body.indexOf('transferHbar(');
  assert.notEqual(evaluateIdx, -1, 'evaluate() call not found in payCreator.ts');
  assert.notEqual(transferIdx, -1, 'transferHbar() call not found in payCreator.ts');
  assert.ok(
    evaluateIdx < transferIdx,
    'evaluate() must appear before transferHbar() in payCreator.ts',
  );
});
