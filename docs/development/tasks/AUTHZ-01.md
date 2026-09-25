# AUTHZ-01 — enforce tool entitlement before business policy

Status: ready for implementation after BUILD-01. This file is an implementation contract; no fix is included in the bootstrap PR.

## User outcome

Disabling an agent's permission for a tool must stop that agent's action even when the tool has a configured business policy that would otherwise allow it. Missing mutating-tool grants must also stop execution.

## Verified starting behavior

In reviewed main, `src/platform/tools/registry.ts` checks `effectiveRisk()` only on the legacy fallback path. A matching policy configuration can reach allow/escalate/block without that separate entitlement check. `effectiveRisk()` currently combines entitlement and risk-tier resolution. Preserve the distinction when deciding how to refactor it.

Read `registry.ts`, `grants.ts`, policy config/evaluation and the existing tests before changing code. This brief does not redefine threshold precedence or the business's approved risk policy.

## Scope

- Make entitlement validation mandatory before policy evaluation can authorize or propose a mutating invocation.
- Preserve existing effective risk behavior where no policy configuration exists.
- Preserve granted configured-policy behavior after entitlement succeeds.
- Explicitly test disabled read grants as well as missing/disabled mutation grants; preserve documented no-grant defaults for ordinary read-only tools.
- Preserve meaningful audit/error evidence for denial without executing the handler.
- Add focused tests of the registry dispatch path, not just isolated rule helpers.

Expected paths: `src/platform/tools/registry.ts` and relevant test files. A small helper extraction is reasonable. Broader schema, billing, approval execution, startup grant-seeding or UI changes belong to their own bounded tasks.

## Acceptance cases

| Case | Expected outcome |
| --- | --- |
| Mutating tool, no grant, configured allow policy | Handler never runs; no pending action is presented as authorized |
| Mutating tool, disabled grant, configured allow policy | Handler never runs; clear denial |
| Disabled grant, configured escalation policy | Revocation is not converted into an ordinary threshold approval |
| Valid enabled grant, configured allow policy | Existing allowed invocation still executes and is audited |
| Valid enabled grant, configured escalation/block policy | Existing policy decision remains effective |
| No matching policy | Legacy risk-tier behavior remains correct |
| Read-only tool with no grant | Existing documented read default remains correct |
| Read-only tool with disabled grant | Explicit revocation is respected |

Use deterministic provider/database stubs only where the test needs to drive registry branching. If persistence behavior changes, add real database evidence. Run root typecheck, affected tests and the existing required CI. The verifier independently checks the call path cannot reach `def.execute()` before entitlement succeeds.

## Done and handoff

PR evidence states the starting/candidate commit, changed dispatch behavior, executed checks and limits. The result fixes invocation entitlement; it does not claim approval binding, production authorization or a complete Controller workflow. AUTHZ-02 is the next permission-related contract, while DATA-01 may proceed independently.
