# Running Atlas development through ChatGPT

This is the bootstrap for the workflow proposed on 25 September 2026. It provides agent instructions, setup and ordered task contracts. It does not install or activate an unattended runner.

The owner works through ChatGPT. GitHub stores the code and durable delivery state. A coding environment executes the task. A persistent dispatcher is required to select and resume work after a coding session ends.

## One-time coding environment

1. Open [Codex cloud](https://chatgpt.com/codex), connect GitHub and select `toddilis/atlas`.
2. Create/select the repository environment. Use a Node version compatible with `package.json`; match the current CI baseline when establishing reproducible results.
3. After this bootstrap is on the selected revision, use this setup command:

```bash
bash scripts/codex/setup.sh
```

The same command can be the maintenance script so changed lockfiles are installed on resumed environments. Before the bootstrap is merged, the equivalent setup is `npm ci --no-audit --no-fund` followed by `npm --prefix web ci --no-audit --no-fund`.

4. Keep the first baseline credential-free. The package/typecheck/unit/build checks do not require live business accounts. Database checks use disposable Postgres with pgvector; the existing GitHub CI already defines that environment.
5. Run task `BUILD-01` from `BUILD_QUEUE.md`. Save the actual baseline evidence and any setup blockers against the candidate revision.

Codex cloud checks out the selected revision, runs setup, and uses `AGENTS.md` during its task. Setup has network access to install dependencies. Setup-process exports do not persist into the agent process; configure needed non-secret settings in the environment. These behaviors are documented in [Cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environment).

## Starter task

Use this instruction for the first coding run:

> Work on toddilis/atlas. Read AGENTS.md, PLAN.md and docs/development/BUILD_QUEUE.md. Execute BUILD-01. Establish the actual root and web verification baseline and the database CI result for the selected commit. Persist evidence, repair only environment problems inside the task scope, and identify the next ready task. Do not claim production readiness or enable live business actions. Continue independent authorized work if a specific check is blocked.

The first run establishes a working environment. It does not prove unattended multi-task execution; `BUILD-02` owns that acceptance gate.

## Continuous execution

The [BUILD-02 fixture coordinator](BUILD_LOOP.md) is available for bounded local
handoff/restart rehearsals. It has no live provider and activates no paid runner.

Recommended implementation for BUILD-02:

- A small dispatcher consumes versioned accepted tasks and durable run state. It checks prerequisites, leases one eligible task, records the commit/branch/run identity and invokes a coding job.
- The coding job prepares a reviewable change. Independent verification and review produce evidence for that candidate commit.
- Release logic applies the existing authorized merge/release policy. It records the result and wakes the next eligible task.
- Completion/failure events and a bounded recovery sweep resume work if a wake-up is missed. A restart reconciles existing runs/PRs before launching replacements.
- Start with one task at a time. Increase concurrency only when file/schema ownership and dependency handling work.
- Configure duration, concurrency, retry and spending limits before activating paid unattended execution. A cap blocks/resumes work; it does not mark unfinished work complete.

[Codex GitHub Action](https://learn.chatgpt.com/docs/github-action) and the [Codex SDK](https://learn.chatgpt.com/docs/codex-sdk) are supported building blocks. The Action route uses an OpenAI API key stored as a GitHub secret. Store credentials in the appropriate secret manager, never in chat, a committed file or task text. The required secret name for that documented route is `OPENAI_API_KEY`.

The connected GitHub plugin can prepare branches and PRs. Its presence does not establish that a Codex cloud environment, API budget or unattended dispatcher is already configured. This bootstrap deliberately records those as observable setup gates.

## Delivery roles

| Role | Responsibility |
| --- | --- |
| Director | Select ready scope and dependencies; preserve the task's accepted criteria |
| Contract | Define journey, input ownership, fixtures and expected outcomes |
| Builder | Implement a bounded task and provide reproducible evidence |
| Verifier | Execute the relevant acceptance cases against the candidate revision |
| Reviewer | Inspect correctness, authority, recovery and scope with a separate context |
| Release/recovery | Apply delegated release policy; verify or recover; wake next work |

These are responsibilities, not six permanently running model processes. Do not add an agent framework before the first task and handoff work.

## State and evidence contract

The dispatcher must retain task ID, accepted-contract revision, prerequisites, branch/base/candidate commit, lease/heartbeat, stage, attempts, provider run identifiers, check/review evidence, costs or reserved budget, release identity and next action. The task queue describes scope and dependency order; runtime state belongs in one authoritative durable record rather than competing markdown copies.

Suggested states: ready, leased, building, verifying, reviewing, release-ready, deployed, verified-done, blocked, failed, cancelled. An expired lease triggers reconciliation before retry. A builder cannot make its own approval or weaken its tests to transition to done.

## What the owner supplies

The owner supplies the selected coding environment/account connection, a spending limit for any paid background runner, and the intended production merge/release authority. Existing session authority takes precedence; do not ask again for already-authorized routine steps. Commercial workflow inputs are recorded in `docs/product/CONTROLLER_V1.md`. Unknown billing facts do not prevent test-environment setup, auth review or bounded correctness repairs.
