# AUTH-01 disposable browser acceptance

The `console real auth browser acceptance` workflow builds the production Next app
on Node 20 and drives Chromium against a pinned GoTrue service and a fresh Postgres
database. No production credentials, email delivery, provider calls or business
data are used. Disposable signing keys exist only for this isolated test stack.

Coverage: anonymous protected page/API access, permitted login and trusted actor /
business identity, non-allowlisted real account denial, same-origin signout, and
genuine JWT expiry after the real refresh session is revoked. It waits for the
issued token expiry rather than manufacturing a mock session. Screenshots and
failure traces are uploaded against the workflow candidate revision.

`requireOperator(request?)` independently verifies Supabase `getUser`, the
operator allowlist and the configured business UUID before returning trusted identity.
`supabaseServer()` calls this guard before returning even a cached service-role client.
Mutation routes pass their request to enforce Origin. They must also
enforce their action's entitlement/policy; session authentication is not a grant.
Never take actor/business identity from request parameters.

This pilot assigns all allowlisted operators to one configured business. The
service-role data client bypasses RLS: this is not shared-business membership or
tenant-isolation acceptance. Those gates remain required before another business
shares the environment. This workflow verifies authentication boundaries, not the
full invoice/pricing journey or hosted-provider deployment configuration. The harness
also migrates fresh pgvector PostgreSQL, starts PostgREST and checks that the console
reads its synthetic invoice while excluding another synthetic business's invoice.

Local Docker execution follows the workflow steps, supplying the same disposable
environment variables; `environment.mjs` writes them to a GitHub environment file.
Windows without Docker/Postgres cannot run the real service acceptance locally.
Record the actual successful CI run and candidate before marking acceptance passed.
