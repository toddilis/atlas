# Foundation validation — 2026-09-27

Scope: ARCH-01, based on bootstrap `3d0e3f6195ce2304ccb75baf091f181ab1d89cd4`.
This report travels with the candidate commit; the export manifest records that commit
and artifact hashes. Tests concern reference contracts and existing application checks.
The verified implementation is commit `5245c64`, handed off in
[PR #24](https://github.com/toddilis/atlas/pull/24). A following documentation-only
handoff records this identity; contract/test sources are unchanged. Review the PR head
as the merge candidate, not a historical green result on another implementation.

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
| User architectural review | Accepted in task on 27 September 2026: "Reviewed, green lit" |

Checks used Node 20.20.2 and existing lockfile-installed dependency copies from the local
Atlas checkout. The machine's default Node failed with a memory error; Node 20 needed
execution outside the restricted sandbox to resolve the workspace. The first reference
run exposed a throwing wrong-subject validation path; it was fixed and the final full
suite passed. Windows test paths were enumerated explicitly because Node 20 did not
expand `test/*.test.ts`. No test was weakened to bypass a failure.

The initial stacked PR had no remote CI because its bootstrap base was outside the
workflow filter. After #20/#22/#23 merged, PR #24 was retargeted to main and integration
commit `5e6a60b` incorporated those prerequisites. The results above are the original
reference revision's local evidence; combined-candidate remote checks must pass before
merge and are recorded on the PR. User acceptance does not substitute for failed or
missing checks, browser acceptance or production evidence.

Reference validation covers lossless monetary serialization, exact approval fingerprint,
tenant/reference linkage, revision/expiry/revocation, duplicate attempt identities,
uncertain-result ownership, forbidden transition edges, channel-specific confirmation,
unknown outcomes, event registry/payload/version/subject boundaries and fact/proposal
classification. It cannot prove database isolation, current entitlement, provider delivery,
transactional continuation, transport deduplication or replay safety. Those remain the
runtime tasks and acceptance cases in the adoption gap register.
