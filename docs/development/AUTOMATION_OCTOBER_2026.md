# BUILD-02 automation handoff: 1–7 October 2026

This is an evidence/activation handoff, not another work queue or a scheduled job.
The Integration Architect owns `BUILD_QUEUE.md`, PLAN and shared product integration.
Product implementation can proceed independently of these development tools.

## Inspected dependencies and separate deliverables

Inspected 1 October 2026. Both PRs were open drafts, not merged. Their GitHub
discussion timelines were empty; PR-body descriptions of earlier independent agent
review are historical evidence, not approval of this follow-up candidate.

| Deliverable | Exact inspected head | Actual implementation and evidence | Remaining boundary |
| --- | --- | --- | --- |
| [#21 fixture coordinator](https://github.com/toddilis/atlas/pull/21) | `e56cdc50075931b8145a5a0edcb1d7a1bd3693d6` | Single-host immutable journal/CAS, durable task leases and run IDs, subprocess build/verify/review/release, candidate invalidation, unit/task/attempt/concurrency limits, pause/revocation, restart/duplicate wake-up reconciliation. [CI 36100422542](https://github.com/toddilis/atlas/actions/runs/36100422542) reports success. | Local `answer.txt` Git candidates and local receipts only. Fixture units are not dollars. Separate processes are not an adversarial security sandbox. No production builder/store/scheduler or real PR/merge adapter. |
| [#26 independent reviewer](https://github.com/toddilis/atlas/pull/26) | `cd002654ba56b28f4dacbec629e2d10371eb126f` | GitHub/Responses transport, complete bounded source collection, exact candidate/base/CI attempt binding, durable spending reservations, strict response validation, dedicated App check publication, fresh read-only release eligibility command. [CI 36313734586](https://github.com/toddilis/atlas/actions/runs/36313734586) reports success. | Policy disabled, App/model unset, budget zero. Protected identities/ledger/environments and actual provider execution are not installed or verified. This does not implement a persistent builder. |

The follow-up branch `codex/build-02-october-fixture-hardening` preserves both Git
histories and keeps their interfaces separate. It starts from #26 and merges #21,
retaining current queue, architecture and application code. No product migrations.

The new reviewer boundary retains the global concurrency slot after any uncertain
review, including across PR/head/policy changes. CI IDs/attempts must be positive
integers. The fixture runner refuses expired dispatch both at provider and worker
boundaries; prior effects remain reconcilable. Regression coverage includes global
concurrency, cumulative spending, failed/incomplete/rerun CI, expired work and builder
credential stripping. Existing recovery/authority cases remain required.

## Reproducible fixture acceptance

With locked root dependencies and Node 20 installed:

```bash
npm run test:reviewer
npm run test:build-loop
npm run build-loop -- init .atlas-build-loop-october scripts/build-loop/fixture-plan.json
npm run build-loop -- tick .atlas-build-loop-october --crash-after-submit
# Expected exit 86: one original run is pending with its receipt already durable.
npm run build-loop -- run .atlas-build-loop-october
npm run build-loop -- tick .atlas-build-loop-october
npm run build-loop -- status .atlas-build-loop-october
```

Retain the run directory. Check two `done` tasks, eight distinct stage IDs/eight
reserved fixture units, two local release receipts, one successor lease, and the
same first run ID before/after restart. A duplicate terminal wake-up changes no
revision. Automated process tests also race wake-ups and prove bounded fixture
continuation after the launching process exits. **That is not evidence of live
development continuing after this chat terminates. Unattended development is inactive.**

Candidate-specific test outputs, source commit/tree, CI run/attempt, database and
console checks belong in the draft PR and evidence receipt. Do not transfer the
two historical green runs above to a changed candidate. Local environment failures
must be recorded as failures/blocked checks, then verified on a working host/CI.

## Activation checklist — explicit authority still required

All items are unmet unless a later exact-candidate receipt records otherwise.
Checking a box here does not grant permission. Keep paid requests, recurring jobs,
automatic merge and deployment disabled until separately authorized.

| Gate | Concrete configuration / owner decision | Acceptance evidence required |
| --- | --- | --- |
| Trusted installation | Independent review of final workflow/runner/policy revisions; owner-authorized installation on protected default branch. Trusted CI changes cannot be self-certified by this reviewer. | Exact reviewed commit, findings resolved, required CI on its candidate/merge tree; manual trust decision for workflow installation. |
| Reviewer publishing identity | Dedicated Atlas-only GitHub App with `contents:write`, `checks:write`, `actions:read`, `pull_requests:read`; numeric `writerAppId`; private key only in default-branch-only `atlas-review-publisher` environment. App has no main bypass or deployment authority. | Installation ID/App ID and repository/environment rules; harmless candidate token denied ledger writes and App impersonation. Never put key material in receipts. |
| Model credential | Approved provider project/key in default-branch-only `atlas-reviewer` environment as `OPENAI_API_KEY`. Reviewer receives read-only GitHub token, no publishing/release secret. | Environment protection proof, provider project ownership and spend controls, credential rotation/revocation owner. No paid probe before spending authorization. |
| Durable ledger | Protect `atlas-review-ledger` from deletion/force push/non-App writes; explicitly authorize one-time initialization; record initial commit and backup/recovery procedure. | Unauthorized-write denial, CAS conflict/restart fixtures, backup restoration drill preserving reservations and pause. Never recreate ledger to reset spend. |
| Spending policy | Owner-approved model and conservative current input/output rates; explicit USD total and review count, input/output/context limits and request timeout. Current defaults: disabled, zero USD/reviews, 40k input/6k output, 180KB context, 180s request timeout. | Policy hash, cumulative maximum reservations, one global unresolved slot, zero automatic retries after uncertain generation; provider-side cap where supported. Confirm rates at activation. |
| Persistent builder implementation | Select hosting and implement actual coding-provider admission, stable external job/PR IDs, result reconciliation and durable queue/store adapter. Existing local fixture implementation cannot submit real development work. | Fixture transport cases covering before/after dispatch crash, duplicate wake, unknown result, changed candidate, bounded repair; exact live run identities only after separate authority. |
| Builder isolation | Separate runner/security principal with no access to reviewer App key, review ledger writes, trusted runner files, merge/deploy tokens, or live business credentials. Avoid shared writable state or host sockets. | Harmless denied-access probes from adversarial builder; candidate data only flows into trusted collection/review. Environment allowlisting alone is insufficient. |
| Builder spend/retry limits | Approve a separate builder budget, model/rates, wall-clock limit, task count, maximum concurrent jobs and repairs. Reserve actual money/tokens before provider dispatch; unresolved work keeps reservation/slot. | Boundary tests and provider reconciliation against each approved limit. Local fixture units cannot substitute for this policy. |
| Scheduler and continuation | Choose durable host/store and completion/recovery triggers; separately authorize recurring execution. No schedule is installed here. | Stop initiating chat/launcher, stop/restart host or runner, duplicate completion delivery; demonstrate same run recovery, one successor lease and persisted evidence without another chat message. |
| Release authority | Separately authorize permitted repositories/branches, action classes, expiry, approver, revocation and merge/deploy scope. Use a release identity distinct from builder/reviewer. Human merge remains default. | Fresh `gate <PR>` checks candidate/base/CI attempt/policy/reviewer/App; release consumes that exact SHA with current authority and conditional merge precondition. Deploy needs an additional environment/approval decision. A green check alone grants no release permission. |
| Live acceptance | After explicitly approved credentials/spend only: synthetic passing and failing candidates, changed head/base, failed/rerun CI, malformed review, wrong App, pause, budget exhaustion and interruption/restart. | Actual provider/workflow/PR/check IDs, exact commits and outcomes; prove uncertain calls are not retried and no unauthorized release occurs. |

## Shared CI integration handoff

Standalone automation retains #26 read-only tokens, documentation CI, all root/web
checks and current database probes. It adds #21's `build-loop` command and named
fixture/reviewer test commands. Current `verify:architecture` and combined `npm test`
remain intact. Product-specific scripts are not invoked before they exist.

For the coordinator's integrated candidate: preserve #25's
`bash scripts/verify-bound-action-concurrency.sh` after dispatch concurrency; preserve
#19's web `npm test` between typecheck/build, rename its job to
`console auth tests + typecheck + build`, and change the review policy's required job
to the identical name. Include any accepted EVENT/EVIDENCE probe hook after its
migrations land. Re-run database/type-drift/parity checks on the integrated commit.
The Integration Architect owns the resulting shared-file composition; these changes
require independent trusted-workflow review, not automatic reviewer self-approval.

Next bounded automation task: implement the chosen provider's durable admission and
reconciliation adapter with a fixture transport, retaining actual budget reservations
and external run IDs; select the host/provider contract before connecting credentials.
This is an implementation gate, not merely a missing API key. Product queue ownership
and priorities remain with the coordinator.
