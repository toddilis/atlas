# Executable contract boundary

The repository source is `src/platform/contracts/controller-v1.ts`; executable cases
are in `test/architecture_contracts.test.ts` and `test/fixtures/architecture/`.
The pack exports matching copies in `reference/`. These are one source plus an export,
not independently maintained implementations. Run `npm run verify:architecture` in
the repository. No new runtime dependency is required: use existing TypeScript/Zod.

## Version 1 scope

Observation, Decision, Approval, Action, Execution and Outcome schemas cover one
bounded Controller invoice-delivery journey. Action parameters are typed invoice
identity/revision, immutable document reference, exact monetary total and print/email
destination. Additional actions require registered schemas rather than arbitrary
unvalidated parameter bags. Other object families in the Contract Map remain planned.

Every record declares contract version, company and creation time. References carry
company/type/id and a revision when version-specific. Internal IDs are opaque nonempty
strings; provider identities stay in source references and connection mappings.
Timestamps are ISO 8601 with an offset; revisions are positive safe integers.
Money crosses the interface as a nonnegative minor-unit integer string, ISO-style
three-letter currency code and scale. Currency support and matching configured scale
are runtime checks; a syntactically valid currency is not proof of commercial support.
Do not convert money through floating-point numbers.

`company_id` is the canonical business identity. Existing `org_id` may map to it only
through a trusted deployment/membership binding; never infer authority from an input ID.
Connections are nullable only for local effects. Runtime must verify account, connection,
subject and evidence ownership in storage; schema validation cannot prove entitlement.

All reference schemas reject unknown fields. Additive optional fields require a
coordinated reader-first rollout and updated fixtures before writers emit them; older
strict readers are not automatically forward-compatible. Changed meaning, required
fields, removed fields or incompatible enums require a new contract/event version,
consumer inventory and migration ADR. Unsupported versions are quarantined, never
silently interpreted as version 1. Historical evidence retains its original version.

## Event registry and naming

`EventEnvelopeV1` validates the common envelope; it does not alone validate arbitrary
payloads. `ControllerEventV1` requires a registered payload schema and correct company
and fact/proposal classification. Initial wire names are `controller.decision.proposed`,
`controller.action.prepared`, `controller.action.execution_recorded` and
`controller.outcome.recorded`. They are new reference names, not registered runtime events.

The Contract Map's PascalCase names are conceptual names. DecisionProposed maps to
`controller.decision.proposed`; ActionPrepared to `controller.action.prepared`.
Execution lifecycle concepts share `controller.action.execution_recorded` with explicit
state; outcome recording uses `controller.outcome.recorded`. Do not substitute the
existing `controller.invoice.issued` for confirmed delivery. Existing Shopify/Stripe
events remain adapter facts until a trusted normalization step maps them.
DemandSpikeDetected is the sole conceptual demand-spike name; its future wire schema
must be registered before use. No historical event name is rewritten.

## Linkage and limits

`ControllerChainV1` checks tenant references, decision/action revisions, exact approval
intent, recorded authorization time, execution identity and outcome linkage. Its full
fixture is not a requirement that every observation have every later stage. Individual
records may exist without an action, execution or outcome; never fabricate absent stages.

The versioned SHA-256 action fingerprint covers parsed immutable intent, including
company, decision/action revisions, target, parameters, policy and idempotency identity.
Keys are lexically sorted, arrays retain order, and JSON scalar encoding is preserved.
Creation/preparation/authorization timestamps and execution progress are excluded.
Compute this on the trusted server from stored intent. A hash supplied by a caller is
not authorization, a signature or evidence of an authenticated approver.
