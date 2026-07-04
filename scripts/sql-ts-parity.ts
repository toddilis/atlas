// SQL↔TS parity check (PR-M) — the deterministic-boundary claim, executed instead of
// asserted in comments: the TS mirrors (computeGstCents, ageBucket) must produce identical
// results to the canonical SQL functions (compute_gst_cents 0014, age_bucket 0015) that
// draft_invoice_atomic / generate_statement_atomic actually use. Runs the SQL against a
// real database (psql must be on PATH) and compares over a grid including every boundary.
//
// Usage: DATABASE_URL=postgres://… tsx scripts/sql-ts-parity.ts
//
// Grid note: subtotal × rate stays below 2^53 so the TS side is exact. Above that the JS
// number implementation loses precision where SQL bigint does not — tracked in PLAN.md
// (PR-N) as an explicit input bound or bigint port.

import { execFileSync } from 'node:child_process';
import { computeGstCents } from '../src/platform/pricing/tax.js';
import { ageBucket, overdueDays, DEFAULT_TIMEZONE } from '../src/platform/pricing/aging.js';

const dbUrl = process.env.DATABASE_URL;
if (!dbUrl) {
  console.error('DATABASE_URL is required (postgres with migrations applied)');
  process.exit(2);
}

function psqlRows(sql: string): string[] {
  const out = execFileSync('psql', [dbUrl!, '-X', '-tA', '-v', 'ON_ERROR_STOP=1', '-c', sql], {
    encoding: 'utf8',
  });
  return out.trim().split('\n').filter(Boolean);
}

let failures = 0;
const fail = (msg: string) => {
  failures += 1;
  console.error(`MISMATCH  ${msg}`);
};

// ---------- compute_gst_cents ----------
const subtotals = [0, 1, 3, 33, 99, 100, 999, 6667, 12345, 1000000, 123456789, 999999999];
const rates = [0, 1, 3, 125, 1000, 1500, 9999, 10000];

const gstValues = subtotals
  .flatMap((s) => rates.map((r) => `(${s}::bigint, ${r}::int)`))
  .join(', ');
const gstRows = psqlRows(
  `select subtotal, rate, compute_gst_cents(subtotal, rate)
     from (values ${gstValues}) as g(subtotal, rate)`,
);
for (const row of gstRows) {
  const [subtotal, rate, sqlResult] = row.split('|').map(Number);
  if (subtotal === undefined || rate === undefined || sqlResult === undefined) {
    throw new Error(`unparseable psql row: ${row}`);
  }
  const tsResult = computeGstCents(subtotal, { rateBps: rate, exempt: false });
  if (tsResult !== sqlResult) {
    fail(`compute_gst_cents(${subtotal}, ${rate}) — SQL ${sqlResult}, TS ${tsResult}`);
  }
}
console.log(`gst parity      ${gstRows.length} cases checked`);

// ---------- age_bucket ----------
const days = [-365, -30, -1, 0, 1, 15, 29, 30, 31, 45, 59, 60, 61, 89, 90, 91, 180, 365];

const dayValues = days.map((d) => `(${d}::int)`).join(', ');
const bucketRows = psqlRows(
  `select d, age_bucket(d) from (values ${dayValues}) as g(d)`,
);
for (const row of bucketRows) {
  const [dStr, sqlBucket] = row.split('|');
  const d = Number(dStr);
  const tsBucket = ageBucket(d);
  if (tsBucket !== sqlBucket) {
    fail(`age_bucket(${d}) — SQL '${sqlBucket}', TS '${tsBucket}'`);
  }
}
console.log(`aging parity    ${bucketRows.length} cases checked`);

// ---------- overdue_days (0020: calendar days in a timezone) ----------
const instantPairs: Array<[string, string]> = [
  ['2026-06-01T00:00:00Z', '2026-06-16T00:00:00Z'],   // plain delta
  ['2026-06-01T00:00:00Z', '2026-06-14T23:00:00Z'],   // calendar 14 vs elapsed-floor 13
  ['2026-04-04T10:30:00Z', '2026-04-05T12:15:00Z'],   // NZ DST end: 25.75h elapsed = 2 calendar days
  ['2026-09-26T09:30:00Z', '2026-09-27T13:30:00Z'],   // NZ DST start weekend
  ['2026-06-30T13:00:00Z', '2026-07-01T11:00:00Z'],   // same NZ day, UTC crosses midnight
  ['2026-06-20T00:00:00Z', '2026-06-16T00:00:00Z'],   // negative (due in future)
  ['2026-06-16T12:00:00Z', '2026-06-16T12:00:00Z'],   // zero
];

const pairValues = instantPairs
  .map(([a, b]) => `('${a}'::timestamptz, '${b}'::timestamptz)`)
  .join(', ');
// Rows come back in VALUES order, so pair them positionally.
const dayRows = psqlRows(
  `select overdue_days(a, b, '${DEFAULT_TIMEZONE}')
     from (values ${pairValues}) as g(a, b)`,
);
for (let i = 0; i < instantPairs.length; i += 1) {
  const pair = instantPairs[i]!;
  const row = dayRows[i];
  if (row === undefined) throw new Error(`missing overdue_days row for pair ${pair[0]} → ${pair[1]}`);
  const sqlDays = Number(row);
  const tsDays = overdueDays(new Date(pair[0]), new Date(pair[1]), DEFAULT_TIMEZONE);
  if (tsDays !== sqlDays) {
    fail(`overdue_days(${pair[0]}, ${pair[1]}, ${DEFAULT_TIMEZONE}) — SQL ${sqlDays}, TS ${tsDays}`);
  }
}
console.log(`days parity     ${instantPairs.length} cases checked`);

if (failures > 0) {
  console.error(`\n${failures} parity mismatches — the TS mirror has drifted from the SQL boundary`);
  process.exit(1);
}
console.log('\nOK — SQL and TS money functions agree on every grid point');
