# Foundation validation — 2026-09-27

Scope: ARCH-01, based on bootstrap `3d0e3f6195ce2304ccb75baf091f181ab1d89cd4`.
This report travels with the candidate commit; the export manifest records that commit
and artifact hashes. Tests concern reference contracts and existing application checks.

| Check | Result |
| --- | --- |
| Root TypeScript check (`tsc -p tsconfig.json --noEmit`) | Passed |
| Contract tests (`node --test --import tsx test/architecture_contracts.test.ts`) | 16 passed; included in full suite |
| Full root unit suite | 103 passed, 0 failed, 0 skipped |
| Root production build (`tsc -p tsconfig.build.json`) | Passed |
| Console TypeScript check | Passed |
| Console Next.js production build | Passed; seven static pages generated |
| Architecture/integration Markdown target checks | Passed during pack export |
| Export file hashes and ZIP integrity | Passed during pack export |
| Database migration/parity | Not run: no database or migration changes |
| Provider, browser journey and live pilot | Not run: no runtime/provider/UI behavior changes |
| Independent architectural review | Pending; draft PR is the review handoff |

Checks used Node 20.20.2 and existing lockfile-installed dependency copies from the local
Atlas checkout. The machine's default Node failed with a memory error; Node 20 needed
execution outside the restricted sandbox to resolve the workspace. The first reference
run exposed a throwing wrong-subject validation path; it was fixed and the final full
suite passed. Windows test paths were enumerated explicitly because Node 20 did not
expand `test/*.test.ts`. No test was weakened to bypass a failure.

The existing CI workflow targets PR bases `main` and `claude/**`; this stacked draft's
`codex/atlas-autonomous-build-bootstrap` base is outside that filter. Remote CI must not
be reported as passed or independent verification merely from these local results.
Before merge/release, obtain required checks on the actual target/candidate and resolve
the existing stacked-PR CI coverage limitation through the release owner.

Reference validation covers lossless monetary serialization, exact approval fingerprint,
tenant/reference linkage, revision/expiry/revocation, duplicate attempt identities,
uncertain-result ownership, forbidden transition edges, channel-specific confirmation,
unknown outcomes, event registry/payload/version/subject boundaries and fact/proposal
classification. It cannot prove database isolation, current entitlement, provider delivery,
transactional continuation, transport deduplication or replay safety. Those remain the
runtime tasks and acceptance cases in the adoption gap register.
