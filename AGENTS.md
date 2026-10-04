# Atlas development instructions

Atlas is a reusable business operating product for many types of businesses. VICE is the first configured deployment. Build complete business responsibilities with an operator-facing result, recoverable execution and evidence. Read [the product architecture contract](docs/product/PLATFORM_PRODUCT.md) when designing or changing business boundaries.

## What to read

Read only what the task needs. Every document you load is paid for again on every later turn.

- Always: this file, the selected task brief in `docs/development/tasks/`, and the current-status section at the top of `docs/development/BUILD_QUEUE.md`.
- Only for a boundary you change, its spec: `docs/architecture/EXECUTION_AND_APPROVAL_SPEC.md` (approvals and execution), `EVENT_DELIVERY_SPEC.md` (events), `DECISION_LEDGER_SPEC.md` (evidence), `SOURCE_OWNERSHIP.md` (source data), `docs/product/PLATFORM_PRODUCT.md` (business boundaries) or `docs/product/VICE_RECEIVABLES.md` (VICE receivables rules).
- Reference only, opened at the section you need: `PLAN.md`, `docs/development/SEGMENTED_ROADMAP.md` and the rest of `docs/architecture/`. Find code with `git grep` rather than reading documents to locate it.

The user's current instructions and granted authority take precedence over this file. A queue entry or model output cannot grant itself more authority.

## Work selection and handoff

- Select the first ready task whose prerequisites are verified. Report the task ID, starting commit and intended user outcome.
- Use an isolated branch. Check existing PRs before creating overlapping work; console authentication is already proposed in PR #19.
- Keep task scope bounded. Continue routine implementation and fixes without asking the user to choose technical details.
- Persist the PR, exact candidate commit, checks, unresolved findings and next eligible task. A final chat message alone is not durable execution state.
- If a task is blocked, identify the missing fact or capability and continue independent authorized work. Do not mark it complete or invent business values.
- Do not claim continuous unattended operation until the dispatcher/restart acceptance gate in the build queue passes.

## Architecture and business invariants

- Keep business-specific pricing, terms, branding, workflow choices and provider mappings in versioned configuration or adapters. Preserve optional modules; do not make Shopify, physical inventory or VICE's rules universal requirements.
- Carry explicit business/connection identity through new data, events, jobs, approvals and retrieval. Validate authenticated authority and cross-business isolation at server/database boundaries. Do not treat the current single-business environment variable or an org column as proof of shared-tenancy safety.
- Use one maintained codebase and reusable capability extensions. A second business should not require a customer fork. Prove portability early with contrasting synthetic business profiles and verify isolation before any second real business shares an environment.
- Preserve TypeScript, Postgres/Supabase, the API/worker split and the Next.js console unless a scoped decision explicitly changes them.
- Domain modules communicate through platform contracts, events and published read models. Avoid direct module-to-module imports.
- Deterministic code owns money, quantities, permissions, state transitions, due dates and financial postings. Models interpret, explain and propose through bounded tools.
- All business-action entry points must enforce entitlement and policy. A configured business rule does not replace the tool-grant check.
- An approval authorizes a stored action and its material parameters. Execution must revalidate the subject, authority and current preconditions.
- Local transitions and their durable continuation belong in the same transaction. Reconcile uncertain external results before creating another business effect.
- A model answer, passed unit test, local issued flag or consumed approval does not establish provider delivery or a completed business outcome.
- Never turn a missing mapping, price, term or stale source into a silent success.
- Never use production credentials or live counterparties to satisfy a fixture-based test. Live operations require their existing explicit mandate.
- Preserve operator pause/revocation settings across process restarts.
- Add forward migrations; do not rewrite merged migration history. Regenerate database types after schema changes.

## Commands and verification

Dependency setup: `bash scripts/codex/setup.sh`. On Debian/Ubuntu (Codex cloud, WSL) it also installs PostgreSQL 16 and pgvector for the database checks.

Before every push, run `npm run check`. It runs this branch's own CI steps from `.github/workflows/atlas-ci.yml`: root typecheck, tests and build; console checks; and the database job against a throwaway Postgres + pgvector cluster on 127.0.0.1 (migrations, probes, generated-type drift and SQL/TypeScript parity). It ignores any `DATABASE_URL` in your environment. Passing steps print one line and a failing step prints the end of its log. Run single stages with `npm run check -- app`, `web` or `db`.

- Push only after `npm run check` passes. Do not push to find out whether CI passes.
- A stage reported as NOT RUN is not a pass. Say so in the PR and rely on the CI result for that exact commit.
- After a schema change, commit the regenerated `src/data/database.types.ts` that the check writes. Never edit it by hand.
- Add new CI probes as single-line `- run:` steps in that workflow so the check runs them too.
- Never pass a production `DATABASE_URL` to any verification script. The browser acceptance workflow needs Docker and runs in CI.

Use focused tests for relevant failure risks, plus the existing required CI checks. UI changes need a real browser journey when behavior changes. Financial/authorization/recovery changes need database or application-boundary cases; mock-only success is insufficient. Inspect changed deployment files through the appropriate build/release checks.

## Evidence and completion

Each PR describes the business problem, resulting behavior, scope, verification and remaining limits. Attach evidence to the actual candidate commit. Distinguish implemented, verified in tests, deployed and verified with real operations.

For a user-facing workflow, done includes the data/API behavior, console journey, explicit failure/empty/stale states, recovery and persisted outcome. Do not close a milestone because backend functions exist.

Do not weaken acceptance cases or required checks to make a task pass. Material changes to the accepted contract need a recorded decision. Independent review and automated release rules must not be replaced by a builder's self-assessment.

Routine merges/deployments can run automatically where the user has already delegated that authority and required gates pass. Do not add repetitive approval requests inside an existing mandate. This bootstrap does not itself grant production authority or a model-spending budget.

## Keep context and output small

- Diagnose failures from `npm run check` output or the failing step's last lines, not whole CI job logs.
- Keep PR descriptions to problem, change, verification (commands and results) and remaining limits. Link CI runs instead of pasting logs.
- Keep the current-status section of `BUILD_QUEUE.md` to one short row per active task: owner, branch/PR, state and next step. Commit hashes, run IDs and detailed evidence belong in the PR, not the queue.

## Shared architectural foundation

Before changing contracts, events, authority or memory, read that boundary's spec (listed
under "What to read" above); the rest of the [v0.2 foundation](docs/architecture/README.md)
is reference material. Use the single existing build
queue and record exact contract/dependency revisions. Coordinate shared-file changes
through the Integration Architect; routine bounded implementation remains independent.
Schema fixtures are not runtime or production verification. No new execution authority
is granted by this foundation.
