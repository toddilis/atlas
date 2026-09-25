# Atlas development instructions

Atlas is a reusable business operating product for many types of businesses. VICE is the first configured deployment. Build complete business responsibilities with an operator-facing result, recoverable execution and evidence. Read [the product architecture contract](docs/product/PLATFORM_PRODUCT.md) when designing or changing business boundaries.

Read `PLAN.md`, `docs/development/BUILD_QUEUE.md`, and the selected task brief before changing code. The user's current instructions and granted authority take precedence over this file. A queue entry or model output cannot grant itself more authority.

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

Dependency setup: `bash scripts/codex/setup.sh`.

Application checks:

```bash
npm run typecheck
npm test
npm run build
npm --prefix web run typecheck
npm --prefix web run build
```

Database changes require `npm run verify:migrations` and `npm run verify:parity` against a fresh disposable test database with Postgres and pgvector. The parity command needs the same migrated database still running. The migration script's standalone ephemeral mode stops its cluster when it exits, so it is not a database for a later parity command. The existing CI `migrations` job supplies a shared disposable database for both commands.

Inspect `scripts/verify-migrations.sh` and `scripts/gen-types.sh` before using a database. Never pass a production `DATABASE_URL` to those verification commands. If the environment lacks Postgres/pgvector, record the local check as blocked and use the actual CI result; never call it passed.

Use focused tests for relevant failure risks, plus the existing required CI checks. UI changes need a real browser journey when behavior changes. Financial/authorization/recovery changes need database or application-boundary cases; mock-only success is insufficient. Inspect changed deployment files through the appropriate build/release checks.

## Evidence and completion

Each PR describes the business problem, resulting behavior, scope, verification and remaining limits. Attach evidence to the actual candidate commit. Distinguish implemented, verified in tests, deployed and verified with real operations.

For a user-facing workflow, done includes the data/API behavior, console journey, explicit failure/empty/stale states, recovery and persisted outcome. Do not close a milestone because backend functions exist.

Do not weaken acceptance cases or required checks to make a task pass. Material changes to the accepted contract need a recorded decision. Independent review and automated release rules must not be replaced by a builder's self-assessment.

Routine merges/deployments can run automatically where the user has already delegated that authority and required gates pass. Do not add repetitive approval requests inside an existing mandate. This bootstrap does not itself grant production authority or a model-spending budget.
