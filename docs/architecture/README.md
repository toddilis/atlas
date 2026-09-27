# Atlas Architecture v0.2

Status: adopted architectural foundation; runtime adoption is tracked separately.
Date: 2026-09-27. Baseline inspected: `3d0e3f6195ce2304ccb75baf091f181ab1d89cd4`.

Atlas is a company operating system: shared business state, governed decisions and
execution, and evidence-backed learning. VICE is Customer Zero; reusable machinery
belongs in Core, with business rules in configuration and company intelligence.

## Read first

1. [Master architecture](ATLAS_MASTER_ARCHITECTURE.md) and [module map](MODULE_MAP.md).
2. [Contracts](CONTRACT_MAP.md) and [executable Controller contracts](CONTRACT_IMPLEMENTATION.md).
3. [Authority](AUTHORITY_AND_GOVERNANCE.md), [execution](EXECUTION_AND_APPROVAL_SPEC.md),
   [event delivery](EVENT_DELIVERY_SPEC.md), and [source ownership](SOURCE_OWNERSHIP.md).
4. [Decision ledger](DECISION_LEDGER_SPEC.md), [memory](MEMORY_AND_LEARNING_ARCHITECTURE.md),
   and [Core/config boundary](CORE_VS_CONFIG.md).
5. [Parallel protocol](PARALLEL_BUILD_PROTOCOL.md), [Integration Architect](INTEGRATION_ARCHITECT.md),
   [delivery tracks](PARALLEL_TRACK_BRIEFS.md), and [adoption gaps](ADOPTION_AND_GAPS.md).
6. [Operating-model ADR](ADRs/ADR-001-ATLAS-OPERATING-MODEL.md) and
   [foundation adoption ADR](ADRs/ADR-002-FOUNDATION-ADOPTION.md).

## Authority and compatibility

These documents govern future architectural changes. The existing owner-confirmed
receivables requirements and explicit user authority remain binding. Adopt this
foundation alongside the product contract, not by erasing its business decisions.
Existing runtime behavior that differs is an adoption gap, not silently compliant.
Schemas and fixtures are reference implementations; no production entry point is
changed by this pack. Adoption does not grant permission to send invoices or expand autonomy.

The repository's `docs/development/BUILD_QUEUE.md` is the only live queue. Pack exports
include a dated snapshot, never a second editable programme queue. Check current PRs
and their exact revisions before claiming work. Chat history is not durable build state.

## Delivery decision

Make the smallest Controller contracts executable before expanding consequential module
implementation. Continue the first complete journey: eligible dispatch → correctly
priced invoice part → owner approval → printable invoice or separately authorised
email → bank-transfer reconciliation or an owned exception. Capture evidence and
outcome hooks during this work. Independent tracks may develop operator views and
evidence handling against the accepted fixtures; other modules may develop bounded
briefs, connector investigations and read-only prototypes once their own prerequisites
are met. Full memory promotion and additional consequential workflows follow verified
evidence and explicit acceptance gates, without waiting for an abstract platform build.

## Invariants

- Structured operational state is canonical; derived memory is evidence-linked.
- Evidence is append-only; corrections add records rather than rewriting history.
- Deterministic code owns money, policy, transitions, execution and reconciliation.
- Approval binds exact stored intent; current entitlement and preconditions still apply.
- Unknown external results require reconciliation, not a second blind attempt.
- Contracts, events and published read models carry explicit business identity.
- Learning cannot grant authority; approval frequency does not prove business value.
- Outcomes, uncertainty, contradiction and decay control operational memory promotion.
- VICE configuration cannot redefine platform security invariants.
