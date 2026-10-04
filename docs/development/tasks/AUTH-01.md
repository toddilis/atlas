# AUTH-01 — console authentication acceptance, 1–7 October 2026

Owner: Authentication/authorization track. Reuses PR #19 at
`2d6544d027bcafc47afe98927ba9691f7b85f17e` and PR #25 through
`ffa12001ea107794719c6301976a3dd6766a6443`; architecture Controller v1/v0.2
at main `cbcb2e7620e73f1406bc8e31edb5b91687c866fb`.

The request proxy refreshes and validates Supabase sessions. Every call to the
service-role data client independently calls `requireOperator()` before returning
even a cached client. New server actions must call that guard before accessing
privileged data; tool actions then use the stored-action authorization boundary.
The approval API plugin independently requires its configured bearer credential.
Browser-supplied actor, tool, input and business substitutions are refused.

## Disposable browser environment gate

No disposable configuration was present in the local task environment. The coordinator
subsequently located original commit `abd36ceff4a86eb4bd1ae819a4d69599781145ed` with a
reusable GoTrue/Playwright harness; this continuation includes it and adds migrated
PostgREST business reads. `.github/workflows/auth-browser.yml` provisions the following
setup entirely from synthetic values. Execution is a separate gate; do not infer a
pass from the harness being present. Never substitute deployed business credentials.
The precise setup required is:

- A dedicated disposable Supabase project or local Supabase stack with Auth and
  PostgREST, migrated Atlas schema, and a synthetic org plus synthetic data.
- Server `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ATLAS_ORG_ID` and
  `ATLAS_OPERATOR_EMAILS`; matching build-time `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY`. Auth/data projects must match.
- Two confirmed password users: one allowlisted and one excluded. Disable public
  signups. Store test passwords outside Git. No provider credentials or counterparties.
- For expiry acceptance, a short test JWT lifetime and ability to revoke the test
  user's refresh sessions. Wait until the issued JWT actually expires; simply deleting
  browser cookies proves logout/anonymous behavior, not expired-token rejection.
- An isolated console origin. For action tests, isolated API bearer token and
  `ATLAS_ADMIN_ACTOR_ID`, synthetic bound approvals and no live adapters.

Run the exact candidate's console in a real browser. Record candidate SHA, environment
identity, timestamps and each result; do not record credentials or session cookies.

| Case | Required observation |
| --- | --- |
| Anonymous protected page/direct read | Redirect to login; no business data |
| Permitted password user | Protected approvals/invoices/statements load only synthetic org data |
| Excluded password user | Denied notice, session cleared, direct protected navigation still refused |
| Expired access token + revoked refresh token | Session rejected after actual token expiry; no protected read/action |
| Sign-out | Old browser session cannot load protected data |
| Missing/mismatched configuration | Closed login gate; no service-role access |
| Direct action request with absent/forged credential | Refused before storage/tool execution |
| Approved action substitution/cross-business attempt | Refused; persisted intent unchanged |

Local pure auth tests, HTTP boundary tests and SQL probes are separate evidence and
do not satisfy this configured browser gate. Protected pricing editing remains gated.

## Integration

The coordinator owns the canonical queue and shared-file integration. This track owns
web auth, approval routes/control plane, grants/registry and migration 0027 in addition
to the inherited 0022. EVENT/EVIDENCE owns replay adoption and 0025/26. BILL 0028 owns
atomic invoice domain publication and stored document/terms integration. Keep migration
numbers even when this isolated candidate does not contain other tracks' migrations.

Migration 0027 supports atomic invoice per-transaction, rolling and velocity limits.
Configured conditional source requirements remain explicitly blocked until the domain
adapter can verify their source/amount contract in the effect transaction. They are
never silently treated as satisfied. Other consequential tools need their own atomic
domain guards; the generic stored-action checks do not reserve a provider's capacity.

`supabaseServer()` is now async. New console callers must await it. Do not expose its
service credential or the API token to the browser. API/job company identity remains
deployment-bound; this is not acceptance of multiple real businesses in one environment.
