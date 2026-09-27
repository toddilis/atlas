# ADR-001 --- Atlas Operating Model

**Status:** Accepted for v0.1\
**Date:** 2026-09-27

## Context

Atlas is being built through multiple parallel AI-assisted development
tracks. A simple collection of specialist agents would be easy to
reproduce, prone to silo drift, and unable to safely compound knowledge
across business functions.

Atlas therefore requires a shared operating model that makes
cross-functional state, decisions, execution, outcomes and learning
first-class architecture.

## Decision

Atlas will be built as a **company operating system**, not an agent
directory.

The architecture will use:

1.  shared canonical company state;
2.  versioned contracts/events between modules;
3.  deterministic policy and side-effect control;
4.  specialist modules for domain reasoning;
5.  an Executive layer for cross-company synthesis;
6.  immutable operational evidence;
7.  a DIONE-derived graded memory architecture;
8.  a decision/action/outcome ledger;
9.  explicit authority levels;
10. strict separation of learning from governance;
11. strict Atlas Core vs company configuration/intelligence boundaries;
12. an Integration Architect responsible for cross-track seams;
13. repository documentation and contracts as the shared development
    source of truth.

## Consequences

### Positive

-   Parallel development becomes feasible without accepting silo drift.
-   Cross-module intelligence is designed in rather than retrofitted.
-   Atlas can measure whether recommendations actually create value.
-   Company-specific learning can compound without contaminating
    reusable product code.
-   Autonomy can expand safely and audibly.
-   VICE can serve as Customer Zero while preserving a commercial SaaS
    path.

### Costs

-   Shared contracts require discipline.
-   Evidence/outcome capture adds implementation work.
-   Some "fast" module-local shortcuts will be rejected.
-   Memory promotion is intentionally conservative.
-   Integration review becomes a permanent engineering function.

## Rejected alternatives

### Independent agents with direct communication

Rejected because it creates hidden coupling, weak auditability and
inconsistent shared truth.

### LLM-managed state and policy

Rejected because probabilistic systems should not own money,
permissions, critical state transitions or irreversible side effects.

### Learn everything automatically

Rejected because repeated noise, stale correlations and model-generated
claims would contaminate company knowledge.

### Build generic SaaS before Customer Zero

Rejected because Atlas should prove its operating loops against real
workflows first while enforcing the Core/config boundary from day one.
