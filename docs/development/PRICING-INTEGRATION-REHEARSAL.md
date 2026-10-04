# Pricing integration rehearsal — disposable test environment only

This branch is an integration-only draft, not a release candidate or authorization
to activate protected editing. The coordinator approved this bounded rehearsal.

Inputs (ancestry preserved):

| Track | Commit | Tree |
|---|---|---|
| Pricing #28 | bc7ef5b17f3f8613221c3af17040a203d0b57810 | 80f9ff24154910132a57dec1a459e3109b97eaba |
| AUTH #31 | 842c4460d296cd5fcb721205a3001dfc9542219a | dba106ac671bdaeafb1cb9902ebc97b2c5c6832a |
| EVENT #30 | 5beeee2cc7f96ba152337b912e44ee6886928068 | 091c5d9f261b80c3914ad81bab66ba5ec599c481 |

Initial composition: `a3873c542bf6561943405e7e0a0f3288fdcdd002`, tree
`df8c2202eeeaf9de7a331b1233336caabec14ba3`. Resolve the shared workflow using the
automation owner's `ci-reconciliation/resolved/auth-event-atlas-ci.yml`; this
rehearsal does not include #27. Preserve all migration hooks. Database types are
temporarily the dependency's generated file pending combined CI artifact regeneration;
the first type/drift failure is expected and is not passing application evidence.

Required checks: full root and web checks; fresh Postgres/pgvector migrations,
pricing forgery/terms/source-time negatives, actual helper-backed 40/60 A/B invoice
parts, retry/no duplicate amounts, historical snapshots after version change,
DATA/AUTH/EVENT concurrency probes, generated-type drift and SQL/TS parity.
AUTH's browser workflow is preserved; its outcome remains an independent gate.
No pricing route is mounted; no secret, provider, email, bank or deployment is activated.

This composition must not replace the coordinator's final queue/composition. Peer
logic is unchanged. Findings are returned to the owning tracks and domain fixes stay
on #28 with explicit transfer into this rehearsal.
