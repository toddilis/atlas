# BUILD-02: durable fixture coordinator

This implements the **fixture rehearsal** portion of BUILD-02. A bounded Node
process completes an accepted task, checks and reviews its candidate, records a
fixture release, and selects the next eligible task. It can be stopped and resumed
using the same directory. A real coding-provider adapter and live unattended
acceptance are still outstanding; BUILD-02 as a whole remains open.

The only provider is local and harmless: build creates `answer.txt` in a real Git
commit, verification checks its exact contents, a separate review process checks
the tree and parent commit, and release publishes a local receipt. Task prose is
never executed. No credentials, model calls, GitHub writes, merges or deployments
are part of this runner. Fixture review proves stage separation, not an independent
engineering review of this implementation or a product change.

## Run a rehearsal

Requires Node >=20, Git and the root lockfile dependencies (`npm ci`). From the
repository root:

```bash
npm run build-loop -- init .atlas-build-loop scripts/build-loop/fixture-plan.json
npm run build-loop -- run .atlas-build-loop
npm run build-loop -- status .atlas-build-loop
```

`init` accepts a strict, ordered task contract. It refuses an existing run instead
of replacing it. Preserve the directory between invocations: it is the authoritative
state and local provider storage, not a disposable cache. `status` returns JSON
including task status, blocking reasons, limits, accepted-contract hash, source
base/branch, candidate SHA, stable lease, stage attempts, run IDs, check receipts
and fixture PR identities. The fixture PR IDs are not real GitHub pull requests.

`run` advances eligible tasks automatically until done, paused or blocked; it has
an additional 1,000-tick ceiling. Its exit code only indicates command execution,
so inspect task statuses to distinguish completion from a visible blocked result.
`tick` is a single idempotent wake-up. There is no installed background service or
schedule. A caller can supervise this process independently of a chat session.

For a repeatable handoff interruption, use a **fresh** directory for this sequence:

```bash
npm run build-loop -- init .atlas-build-loop-crash scripts/build-loop/fixture-plan.json
npm run build-loop -- tick .atlas-build-loop-crash --crash-after-submit
# The preceding fixture-only failpoint deliberately exits 86 after provider output.
npm run build-loop -- run .atlas-build-loop-crash
```

The second process reconciles the first provider receipt using the original run
identity; it does not launch a replacement build. Keep these temporary rehearsal
directories out of source control. `.atlas-build-loop*/` is ignored by default.

Controls are persisted, including across process restarts:

```bash
npm run build-loop -- pause .atlas-build-loop
npm run build-loop -- revoke-release .atlas-build-loop
npm run build-loop -- resume .atlas-build-loop
```

Resume clears pause only; it does not restore release authority, increase limits,
reset attempts or refund uncertain work. A blocked/uncertain external run retains
its identity and budget. Later wake-ups can reconcile a matching provider receipt;
they do not blindly retry an unknown outcome. Policy changes require a new accepted
run or a future audited operator recovery mechanism, not editing task prose.

## Enforced boundaries

- At most one task is leased at once; its dependencies must be done. Accepted
  limits cap unique leased tasks, attempts, reserved fixture units and run duration.
- One stage dispatch costs one **fixture unit** reserved before submission. These
  are synthetic units, not API tokens or dollars. Limits are part of the accepted
  contract; strict schema validation rejects authority/limit fields inside tasks.
- Each `(workflow, task, attempt, candidate epoch, stage)` has one deterministic
  run identity. Concurrent wake-ups publish state with atomic compare-and-swap.
  The provider also elects one live worker per identity. It only recovers a worker
  claim when the owning process is proven dead; a slow or paused owner is not evicted.
- Verification and review receipts must match the dispatched role, identity and
  candidate. Observing a new candidate clears the old evidence and increments its
  epoch. An unresolved earlier check retains its run ID and concurrency reservation
  until its receipt arrives; it cannot advance the new candidate or be resubmitted.
  If it never resolves, the deadline produces a visible blocked outcome.
  Once release is dispatched, its candidate cannot be changed; first reconcile
  that release. Release independently rechecks authority and current evidence.
- The fixture release record includes its completion evidence atomically. A worker
  interrupted after recording the effect can be reconciled without a separate
  notification, including while paused or revoked. This reports an existing effect;
  it does not restore authority to dispatch new work.
- Build/check failures return to build while attempts and units remain. Exhaustion,
  missing release authority, mismatched receipts and uncertain provider submissions
  remain visibly blocked. A release failure requires reconciliation rather than a
  new release attempt. No counterparty operation can be produced by this provider.
- Fixed build/check/review/release workers run as separate subprocesses without
  inherited business/API credentials or `NODE_OPTIONS`. They never execute the
  generated artifact. Pause/revocation stop subsequent authorized dispatches; they
  cannot undo an effect that already completed.

## Persistence and trust assumptions

State is an append-only sequence of complete JSON snapshots. Each file is written
and flushed under a unique temporary name, then hard-linked to the next generation
without overwriting an existing generation. Losing a writer race triggers a fresh
read. A killed writer's unpublished temporary file is ignored; a published file is
the committed transition. There is no lease-expiry filesystem lock to steal.

This store is for **one host and a persistent local filesystem with atomic hard
links**, such as NTFS/ext4. It is not supported on network shares, copied/merged
state directories or multiple independent disks. It tests process interruption,
not sudden storage loss/power-failure durability. Snapshots and provider receipts
are retained without compaction; use a fresh bounded rehearsal rather than running
this fixture backend indefinitely.

The state/provider directory and runner code are trusted. A hostile process with
write access to them can forge state. Separate subprocesses are not a security
sandbox. A production builder must run in a separate security boundary without
write access to coordinator state, verifier/reviewer identities or release secrets.
The fixture adapter is deliberately not a bridge to an arbitrary shell command.

## Acceptance and remaining gates

`npm test` includes `test/build_loop.test.ts`. It uses actual subprocesses, immutable
disk records and Git objects to test the full two-task journey, crash after provider
submission, simultaneous wake-ups, completion after the launching process exits,
candidate changes with unresolved checks, interruption between release and its
notification, pause/revocation, bounded repair, task/unit caps, uncertain
submission, late results, invalid receipts and invalid contracts. The detached
process test is a controlled analogue of losing the initiating session, not proof
that a live Codex/GitHub runner survives a real chat ending.

Before live activation, still required:

1. Independent engineering review of the coordinator and deployment trust boundary.
2. A production provider that reserves a mechanically enforced spending allowance,
   idempotently dispatches coding jobs, and reconciles actual run/PR IDs. GitHub
   workflow dispatch alone must not be assumed to provide idempotency.
3. A durable shared store/scheduler appropriate to the chosen host, plus completion
   delivery and recovery sweeps. Production builders must not control release jobs.
4. Configured runner credentials, spending/concurrency/retry/duration limits and
   delegated merge/release policy. No paid execution is authorized by this fixture.
5. Live demonstrations of handoff after the initiating chat ends, interrupted-run
   reconciliation, duplicate completion delivery, and commit-bound independent
   verification/review before any permitted release.

BUILD-01 evidence is recorded in PR #20. The implementation starts from its verified
head `d7020433040cb4a5d93aaa14b9f3a38ddd9b814c`. Candidate-specific test and CI results
belong in this implementation's PR description. Existing AUTH-01/PR #19 work can
proceed independently while live BUILD-02 activation is pending.
