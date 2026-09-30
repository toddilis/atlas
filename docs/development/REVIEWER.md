# BUILD-02-REVIEW: independent reviewer integration

Owner: Verification/build infrastructure track. Starting/dependency commit:
`cbcb2e7620e73f1406bc8e31edb5b91687c866fb` (main, including ARCH-01 v0.2).
Branch: `codex/reviewer-integration`. Scope: reviewer transport, durable evidence,
spending reservation and a release eligibility gate. Business contracts, event
schemas, database tables and product modules are unchanged.

The GitHub workflow and provider adapter are implemented; live activation is **off**.
The shipped policy has `enabled: false`, no model/App identity and zero spending
authority. No secret, paid request, repository protection rule, merge or deployment
is installed by adding these files. PR #21 remains the separate fixture coordinator;
this integration does not turn its synthetic review/release into a production runner.

## Execution and trust boundary

`atlas-review.yml` starts after `atlas CI` completes, or from an explicit manual
dispatch naming the PR and CI run. It runs only from the repository default branch.
Every step checks out that trusted commit with persisted Git credentials disabled.
The small dependency-free Node 20 runner installs no packages and never checks out
or executes candidate code. `.mjs` keeps the credential-bearing workflow independent
of a candidate's TypeScript compiler, lockfile or lifecycle hooks.

1. **Prepare:** validate same-repository open PR, allowed target branch, exact
   head/base, CI workflow path/attempt and all required successful jobs. CI workflow
   edits require manual trusted review. Fetch the complete changed-file inventory,
   full before/after text and trusted guidance, verifying Git blob hashes. Unsupported
   binary/LFS/symlink/submodule changes, incomplete inventories and size limits block
   automatic review. Nothing is silently omitted. Reserve the maximum configured
   request allowance in the ledger using GitHub's file-SHA compare-and-swap.
2. **Review:** a separate job receives only a read-only GitHub token and its protected
   OpenAI key. A fresh Responses API request has no builder conversation and no tools,
   shell, GitHub writer or release credential. Source is delimited JSON evidence.
   Count the actual input, recheck pause/current authority, then make one bounded
   generation request with structured output, `store: false` and truncation disabled.
3. **Publish:** a separate App-authenticated job validates the response and reservation,
   rereads PR/CI/current trusted revision, persists the receipt, then publishes
   **Atlas independent review** on the candidate SHA. P0/P1/P2 findings, limitations,
   inconclusive verdicts, missing usage, refusal, timeout or malformed output block it.
   P3 findings are advisory. Findings remain visible in the check and durable receipt.

The dedicated GitHub App gets only this repository and `contents:write`,
`checks:write`, `actions:read`, `pull_requests:read`. Its installation tokens are
short-lived and never reach the model job. The standard `GITHUB_TOKEN` is read-only
in every reviewer job. App credentials must never be a repository-wide secret.
Candidate workflows cannot be allowed to write the ledger or impersonate this App.

The review includes full changed files, configured baseline guidance and CI job
metadata, not the entire repository or test logs. Missing dependency/caller context
must produce `inconclusive`; add justified context to trusted policy or use manual
engineering review. This bounds the first integration without claiming that a model
review replaces tests, human architectural judgment or live acceptance.

## Durable identity, recovery and spending

`atlas-review-ledger:review-ledger.json` is the authoritative ledger. Each entry binds
repository, PR, candidate SHA, base SHA, CI run/attempt, trusted reviewer SHA, policy
hash, full context hash, check ID, workflow run ID and maximum reserved micro-USD.
The outcome additionally records provider response ID, usage, findings and verdict.
One micro-USD is one millionth of a US dollar. The allowance calculation uses approved
input/output rates per million tokens; set conservative current rates for the selected
model and reassess when prices change. This is a configured spending ceiling, not a
promise about charges from an independently changing provider tariff.

Reservations count cumulatively across **all** PRs, revisions and policy updates.
There are no refunds, automatic budget resets, automatic model retries or automatic
ledger recreation. `maxReviews` and `maxTotalMicroUsd` stop further work; a missing or
oversized ledger also stops work. Initialization creates a new branch and refuses an
existing one. Protect it against deletion, force-push and unauthorized updates before
activation. An administrative deletion/recreation is outside the recovery guarantee.

Duplicate wake-ups reuse completed evidence. Unresolved reservations retain their
charge and cannot dispatch again, including after a workflow rerun. Changing policy
or reviewer code does not bypass an unresolved reservation for the same candidate.
Changing the candidate/base/reviewer revision invalidates the earlier eligibility.
Reviews of a new repaired candidate consume another reservation within the same cap.

An unresolved reservation holds the **global single-review concurrency slot**, even
after its GitHub workflow exits. A new candidate, different PR, policy change or
reviewer revision cannot bypass it. Workflow serialization alone cannot establish
that a timed-out remote request has stopped. A complete negative review releases
the slot but retains its spending charge. A missing/malformed/uncertain result
requires explicit reconciliation before any further paid review; do not delete the
ledger entry or turn it into `completed` without authoritative outcome evidence.

If publishing stops after storing a complete receipt, rerunning the publisher (or
dispatching the same candidate) republishes it without a model call. If it stops after
reservation or provider submission but before storing a usable response, the candidate
stays blocked. Inspect the original workflow's request/response artifacts and provider
records; do not delete the entry or press rerun expecting a paid retry. A separately
authorized reconciliation procedure is required for that uncertain outcome. Artifacts
are retained 30 days; the ledger retains the receipt beyond artifact expiry.

`pause` and `resume` manual workflow operations use a separate control concurrency
group. Pause is reread after token counting, immediately before generation, and at
publication/gating. It cannot undo a request already accepted by the provider. Resume
does not replenish budget or retry uncertain work. The control environment must not
wait for a new human approval on each pause; default-branch restriction supplies its
trust boundary. Ledger CAS conflicts fail closed; repeat an explicitly failed control
operation after checking the ledger. GitHub can coalesce pending workflow events;
manually dispatch an omitted candidate with its successful CI run ID.

## Release consumer

From a trusted checkout with a token allowing `contents:read`, `actions:read`,
`pull_requests:read` and `checks:read`, run:

```bash
GH_TOKEN=... node scripts/reviewer/run.mjs gate 25
```

This produces an eligibility receipt only if current head/base, current reviewer
revision/policy, successful CI attempt, unpaused ledger and the dedicated App's
completed successful check all match. Exit 1 means blocked. The gate sends no model
request and has no merge operation. A future live BUILD-02 provider must call this
at release time, use the returned exact candidate as the merge precondition and
separately enforce delegated release authority. Never import a builder-authored JSON
`ok` field as review authority or substitute the fixture coordinator's receipt.

A green commit check is historical evidence. Configure strict up-to-date required
checks for manual GitHub merges, and use this fresh gate in automation. A later pause
does not delete historical GitHub checks; halt/disable any already queued external
merger as part of pausing that merger. No continuous build/merge loop is activated here.

## Activation procedure (operator configuration still required)

1. Independently review and merge this integration. Its default-branch workflow is
   deliberately unable to certify its own installation or a PR changing trusted CI.
2. Create a dedicated GitHub App installed only on Atlas, with the permissions above.
   Record its numeric App ID as `writerAppId` in trusted policy. Keep `enabled: false`.
3. Create `atlas-review-publisher` and `atlas-reviewer` GitHub environments restricted
   to the protected default branch **by name**. Store the App PEM private key only as
   publisher environment secret `ATLAS_REVIEW_APP_PRIVATE_KEY`. Store the OpenAI key
   only as reviewer environment secret `OPENAI_API_KEY`. No keys belong in chat or Git.
4. Set repository rules so only the dedicated App can update `atlas-review-ledger`,
   including creation if rules cover nonexistent branches. Block deletion/force pushes
   and all candidate/GitHub Actions writes. Protect main/reviewer/workflow/policy changes
   with independent code-owner review; the reviewer App must have no main bypass.
   If the repository plan cannot enforce these boundaries, keep paid execution disabled.
5. Manually dispatch `initialize` once from main. Record and back up the initial ledger
   commit. Do not use initialization as recovery. Confirm a candidate-token write to the
   protected ledger is denied using a harmless probe before enabling paid execution.
6. Approve a supported review model, conservative input/output rates, total USD budget
   and maximum number of reviews. Set policy limits and `enabled: true` through trusted
   review. Defaults cap each request at 40,000 input / 6,000 output tokens, 40 files,
   180 KB full context, 180 seconds per provider request, one active review workflow.
7. Run a small synthetic passing PR and a deliberate failing PR. Confirm exact-head
   findings and the independent check. Configure **Atlas independent review** as a
   required check with the dedicated App as its expected source, plus existing CI and
   strict up-to-date requirements. Do not choose "any source" or GitHub Actions.
8. Test duplicate delivery, changed head/base, pause during preflight, exhausted budget,
   interruption before/after provider submission and publisher restart. Run the fresh
   gate at each boundary. Record actual run IDs and outcomes before declaring live
   reviewer acceptance. Human merge approval remains separate from reviewer activation.

The integration uses [Responses structured output](https://developers.openai.com/api/docs/guides/structured-outputs),
[input token counting](https://developers.openai.com/api/docs/guides/token-counting),
[GitHub workflow_run](https://docs.github.com/en/actions/reference/workflows-and-actions/events-that-trigger-workflows#workflow_run),
[App installation tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
and [App-bound required checks](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches).

## Verification and handoff

`node --test test/reviewer/*.test.mjs` tests provider request/response boundaries,
strict CI and candidate identity, durable reservation, CAS races, recovery, spending,
pause, stale policy/context, publisher provenance and source integrity. It runs in
`npm test` alongside the application tests. Required CI now also runs on documentation
changes so an evidence-only final commit can receive a current review.

The implementation received a separate read-only agent review. Its first findings
were the writer identity, a Unicode CI-name mismatch, pause queuing, stale reviewer
identity and documentation-only CI. Those repairs have regression coverage. This is
development review evidence, not a paid run of the new integration.

Candidate-specific checks and remaining findings belong in this PR and its final
verification receipt. BUILD-02 remains open for the live builder/provider, scheduler,
durable task-store integration and real chat-end/interruption acceptance. Product
queue priorities and all business execution authority remain unchanged.

The [1–7 October handoff and activation checklist](AUTOMATION_OCTOBER_2026.md)
records the separate reviewer/runner deliverables and the fixture-only follow-up.
