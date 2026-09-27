# Atlas Parallel Build Protocol v0.2

## Goal

Allow multiple ChatGPT/Codex build conversations to develop Atlas
simultaneously without architecture drift, duplicated work or
incompatible contracts.

## 1. Repository is the shared development brain

Chats are workers, not the source of truth.

Each build track must begin by reading: - `README.md` -
`ATLAS_MASTER_ARCHITECTURE.md` - `MODULE_MAP.md` - `CONTRACT_MAP.md` -
`AUTHORITY_AND_GOVERNANCE.md` - relevant module docs - active build
queue/plan - relevant ADRs - recent merged PRs touching shared contracts

## 2. One bounded track per conversation

Examples: - Controller - Quartermaster - Marketer - Brand Brain -
Integration Architect - Verification/Release

A track receives a bounded brief containing: - objective - scope -
non-scope - affected contracts - invariants - risk class - acceptance
cases - required evidence - expected cross-module impacts

## 3. Shared queue

There must be one authoritative build queue. Parallel chats cannot
independently redefine programme priority.

Each work item should declare: - ID - owner/track - dependencies -
files/contracts expected to change - status - merge dependency -
verification requirement

## 4. Branch isolation

Each build track works on its own branch/PR.

No track assumes another unmerged branch exists unless explicitly
declared as a dependency.

## 5. Contract-first change rule

If a feature needs a new shared concept: 1. define/update the contract,
2. request Integration Architect review, 3. identify
consumers/migrations, 4. then implement.

Do not solve cross-module needs with private database fields or direct
imports merely because it is faster.

## 6. Required PR handoff

Every PR must state:

``` text
What changed:
Why:
Shared contracts changed:
Events emitted/consumed:
Data migrations:
Policy/authority impact:
Evidence/outcome impact:
Other modules affected:
Core-vs-config assessment:
Tests:
Production verification:
Known follow-up:
```

## 7. Independent verification

Builders do not self-certify consequential work.

Use an independent read-only review track for: - architectural
compliance - acceptance cases - risk/policy - integration seams -
evidence completeness - CI/production verification

## 8. Integration cadence

The Integration Architect should review all active tracks frequently
enough that shared decisions are caught before large implementations
diverge.

For every merge wave: 1. inspect active PRs, 2. update contract map if
required, 3. identify cross-play, 4. resolve collisions, 5. determine
merge order, 6. update build queue, 7. run journey-level verification.

## 9. Journey-first acceptance

A feature is not complete because a service or unit test works.

For meaningful vertical slices verify:

`client → contract → auth → persistence → decision/policy → worker/tool → confirmed side effect → visible operator state → audit/evidence → outcome hook`

## 10. Current sequencing

Continue the Controller vertical slice as the first proving ground.

In parallel: - formalise shared architecture/contracts, - establish
Integration Architect, - ensure Controller emits the evidence required
by the decision/memory architecture.

Once those foundations are stable, additional module tracks can proceed
in parallel with declared dependencies.

## 11. v0.2 repository integration

Use the existing repository queue at `docs/development/BUILD_QUEUE.md`; exported copies
are dated snapshots. Preserve task IDs and already-open PR dependencies. Track briefs
and merge-wave rules are in [Parallel Track Briefs](PARALLEL_TRACK_BRIEFS.md). Record a
contract version and exact dependency commit, expected files, owner, status, merge
constraints and verification for each claim. Integration review applies to shared
boundary changes; ordinary implementation within accepted contracts stays independent.
