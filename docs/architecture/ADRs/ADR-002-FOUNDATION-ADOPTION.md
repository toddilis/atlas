# ADR-002 — Adopt the v0.2 foundation and stage runtime adoption

Status: accepted for architecture and reference contracts by user direction, 2026-09-27.

## Decision

Adopt the pack in repository documentation, keeping the existing product/receivables
contracts and build queue authoritative for business scope and delivery status. The
foundation governs shared architectural boundaries; explicit owner decisions remain
binding. Resolve conflicts visibly in an ADR rather than silently choosing a document.

Use existing TypeScript/Zod for a minimal Controller contract package and fixtures.
Keep conceptual event names separate from stable namespaced wire names. Use explicit
business references and lossless money strings. Approvals bind immutable action intent;
execution attempts, delivery evidence and business outcomes remain distinct.

Extend the existing queue and PR dependency graph. Prove Controller before broadening
consequential workflows; allow independent fixture-based UI/evidence work and bounded
module preparation in parallel. Integration review focuses on shared boundaries.

## Consequences

Reference schemas do not alter runtime authorization, persistence or delivery. Adoption
requires the bounded AUTHZ-02, EVENT-01, EVIDENCE-01 and existing Controller tasks with
forward migrations and independent verification. No production authority is added.
Unknown historical evidence stays unknown. Existing event consumers are not broken by
renaming or redefining their payloads in this documentation change.

Approval frequency records preference; it cannot establish business value or independently
qualify an authority increase. Outcomes, recovery history and explicit governance matter.

## Rejected alternatives

- A second architecture-only live queue: competing ownership and priorities.
- All module teams inventing local contracts: late incompatibility and duplicate concepts.
- A broad platform rewrite before Controller: delays proving the operational journey.
- Claiming safeguards from documentation alone: hides unresolved runtime risks.
