# ARCH-01 — architecture foundation and executable reference contracts

Owner track: Integration. Starting commit: `3d0e3f6195ce2304ccb75baf091f181ab1d89cd4`.
Branch: `codex/architecture-foundation-v02`. Base: `main` after bootstrap PR #20 merged.
Contract version: Controller v1; documentation pack v0.2. Status: implemented locally,
verification recorded in the [validation report](../../architecture/VALIDATION.md).
Review handoff: [PR #24](https://github.com/toddilis/atlas/pull/24).
Verified implementation commit: `5245c64`; subsequent handoff-only documentation changes
do not alter the tested contracts, fixtures or runtime. The PR head is the merge candidate;
User review was accepted on 27 September 2026 ("Reviewed, green lit"). Integration
commit `5e6a60b` includes merged #20/#22/#23; required combined-candidate CI remains
the merge gate. See the current queue status and PR checks for the release result.
Combined implementation `901dc91` passed CI run `36306553820`, including 136 tests,
root/console builds and real database/concurrency/type-generation/parity checks.
Subsequent evidence-only documentation preserves that executable implementation;
the final candidate's checks and merge state are recorded on PR #24.

## Outcome

Parallel builders share one architectural foundation, minimal typed Controller contracts,
failure fixtures and an existing queue with explicit dependency/verification rules.
Runtime changes stay in their owning tasks; this change does not grant live authority.

## Boundaries and evidence

Expected surfaces: architecture documentation, existing README/AGENTS/PLAN/queue,
`src/platform/contracts/controller-v1.ts`, contract tests/fixtures, package script.
No migration, provider integration, runtime registration or UI behavior changes.
Financial and authorization semantics require independent review before adoption.

Acceptance: lossless money, exact approval intent, business/reference linkage, explicit
unknown outcomes, evidence-backed confirmation and invalid-transition rejection in
reference tests; documented runtime gaps; no competing queue; consistent terminology
and valid local links. Passing fixtures do not satisfy AUTHZ-02/FLOW-01 acceptance.

Review candidate and test evidence are attached to the PR/current commit. On amendments,
rerun affected checks and invalidate prior review evidence. Dependent runtime PRs merge
after this contract revision and their existing prerequisites. AUTHZ-01, DATA-01 and
authentication PRs remain independent and are not changed or merged by this task.

## Next eligible work

Check BUILD-01 and current open PR heads before assigning work. Existing DATA-01 and
PRICING-01 priorities remain. AUTHZ-02 may adopt the new contract once AUTHZ-01 and this
foundation merge; EVENT-01/EVIDENCE-01 and fixture-based operator work may proceed with
declared contract dependencies. No unverified task is marked complete by this handoff.
