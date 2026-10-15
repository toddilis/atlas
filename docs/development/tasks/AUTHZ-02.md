# AUTHZ-02 — exact stored-action authority

Owner: Authorization track. Branch: `codex/authz-02-bound-actions`.
Starting main: `cbcb2e7620e73f1406bc8e31edb5b91687c866fb`.
Dependencies: AUTHZ-01 and architecture Controller v1 contracts on that main;
EVENT-01 replay-context contract `102435c` (locally cherry-picked as `6897b69`).

The operator's approval must execute exactly the persisted tool, subject, material
snapshot and losslessly encoded input. Callers cannot substitute tool arguments or
agent identity after approval. Changed policy/subject, revoked grants, paused agents,
expired/revoked approvals and wrong-company contexts refuse execution.

Migration 0022 owns immutable approved intent, atomic claim, durable attempts and
transactional audit evidence. Stable effect identity survives a known-no-effect retry.
Unknown provider results and abandoned leases require reconciliation. Local invoice
issuance is distinct from delivery; the legacy Stripe continuation is held pending
separate provider authority. Existing unbound approvals require fresh proposals.

The trusted admin API binds actor to `ATLAS_ADMIN_ACTOR_ID` and business to deployment
configuration behind its existing bearer gate. This pilot binding is not shared-tenancy
acceptance. Console decision/recovery integration remains UI-01/FLOW-01.

Verification: application-boundary tests plus fresh Postgres RPC/role/expiry/snapshot
probes and separate-session competing claims. CI regenerates database types and checks
parity. Candidate checks and independent review must be recorded before merge.

Next eligible integration: EVENT-01/EVIDENCE-01 canonical evidence linkage, followed by
the protected operator recovery journey when FLOW-01 dependencies are available.
