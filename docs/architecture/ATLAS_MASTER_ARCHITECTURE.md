# Atlas Master Architecture v0.2

## 1. Product definition

Atlas is a **commercial AI company operating system** for owner-operated
and small-to-medium businesses. It combines reliable company state,
specialist operating modules, governed AI reasoning, execution
infrastructure, and an evidence-backed learning system.

The product thesis is not "agents for each department." The
differentiated system is:

> **Sense the company → build a shared model → detect what matters →
> decide → act within authority → measure outcomes → learn → improve
> future decisions.**

Atlas should eventually be capable of operating meaningful portions of a
business while keeping consequential authority explicit, bounded and
auditable.

VICE is the first live operating environment and training ground. Atlas
Core must be designed so the same machinery can later be configured for
other businesses.

## 2. Product layers

### Layer A --- Systems of record and integrations

External systems remain authoritative where appropriate: commerce,
accounting, payments, inventory, CRM, logistics, communications,
advertising and other operational platforms.

Connectors ingest events and expose bounded tools. Atlas does not
silently replace upstream truth.

### Layer B --- Canonical company state

Atlas maintains normalized business entities and read models so all
modules reason over the same company.

Examples: - customers and accounts - products/SKUs - orders -
invoices/payments - inventory positions - suppliers and purchase
orders - campaigns/creative - leads/opportunities - service cases -
risks/opportunities - tasks/commitments - decisions/actions/outcomes

### Layer C --- Evidence spine

Every meaningful observation, proposal, approval, action and outcome
produces durable evidence with provenance.

This layer exists so Atlas can answer: - What happened? - What did Atlas
know at the time? - What did it recommend? - Why? - Who authorised it? -
What actually executed? - What happened afterwards?

### Layer D --- Company Brain

The Company Brain contains derived organisational memory and reusable
knowledge. It is evidence-linked and graded rather than treated as truth
merely because an LLM generated it.

It includes episodic, semantic and procedural memory, while
governance/policy remains separately controlled.

### Layer E --- Decision and action engine

Specialist modules detect situations and propose decisions.
Deterministic policy evaluates whether the action is permitted, requires
approval, or must be blocked/escalated.

### Layer F --- Business modules

Atlas exposes functional operating modules such as Controller,
Quartermaster, Rep and Marketer. Modules own domain reasoning, not
isolated private universes.

### Layer G --- Atlas Executive

The Executive layer synthesizes cross-company state and asks: - What
changed? - What matters? - What conflicts? - What requires a decision? -
What can Atlas safely handle? - What should the operator know? - What
did the company learn?

It does not bypass module authority or mutate source-of-truth state
directly.

### Layer H --- Operator experience

A unified workspace exposes: - company briefing - decision queue -
approvals - risks/opportunities - module views - actions in progress -
unresolved execution - learning ledger - audit/recovery

## 3. Shared platform services

Atlas Core should provide reusable infrastructure for:

-   identity/authentication
-   tenant/company configuration
-   integrations/connectors
-   event ingestion
-   canonical projections/read models
-   policy evaluation
-   permissions/authority
-   approvals
-   tool execution
-   idempotency
-   outbox/jobs/workers
-   audit/evidence
-   observations/detections
-   decisions/actions/outcomes
-   AI/model gateway
-   memory and learning
-   notifications
-   recovery/reconciliation
-   operator console
-   telemetry/evaluation

## 4. Operating loop

1.  **Observe** --- ingest reliable operational evidence.
2.  **Model** --- update canonical state/read models.
3.  **Detect** --- identify risks, opportunities, anomalies or required
    work.
4.  **Decide** --- deterministic logic and AI reasoning produce a
    bounded proposal.
5.  **Authorise** --- policy determines permitted authority and approval
    requirements.
6.  **Act** --- tools execute with idempotency and confirmation.
7.  **Measure** --- capture operational and business outcomes.
8.  **Critique** --- compare expectation with result and identify
    confounders/failures.
9.  **Learn** --- reinforce, weaken, supersede or create derived memory.
10. **Repeat**.

## 5. Architecture boundary: deterministic vs probabilistic

### Deterministic code owns

-   arithmetic and financial calculations
-   state transitions
-   permissions and policy
-   account/action allowlists
-   monetary/risk caps
-   reconciliation
-   idempotency
-   side-effect execution
-   audit persistence
-   promotion rules for durable memory
-   authority changes

### AI owns or assists

-   interpretation
-   summarisation
-   classification where uncertainty is acceptable
-   hypothesis generation
-   ranking options
-   proposal/rationale generation
-   cross-domain synthesis
-   extracting candidate learnings
-   explaining decisions

AI output is evidence or a proposal until deterministic controls accept
it.

## 6. Cross-functional intelligence

Atlas earns its value when signals cross departmental boundaries.

Example:

`DemandSpikeDetected` from Marketer may cause: - Quartermaster to
recalculate stockout exposure, - Controller to model working-capital
requirements, - Rep to alter account availability expectations, -
Executive to surface the combined decision, - Learning Engine to later
assess whether the response improved margin/service level.

Cross-play must be explicit through contracts and subscriptions rather
than hidden agent-to-agent conversation.

## 7. Commercial product boundary

The long-term product is configurable Atlas Core plus company-specific
intelligence.

A customer should connect systems, map its operating model, configure
authority, import company knowledge and progressively allow Atlas to
operate.

The moat is expected to compound from: - reliable cross-functional
company state - evidence-backed company memory - decision/outcome
history - reusable operating procedures learned from real outcomes -
safe autonomy infrastructure - cross-module intelligence -
company-specific knowledge without contaminating the reusable core

## 8. Build principle

Do not build the entire abstract platform before proving workflows.

Build **vertical slices** that cross: client → contract → auth →
canonical persistence → decision/policy → tool/worker → execution
confirmation → visible operator outcome → evidence/outcome capture.

Controller is the first proving ground. Every subsequent module should
reuse and harden the shared substrate.

## 9. Foundation adoption and delivery

The v0.2 [adoption ADR](ADRs/ADR-002-FOUNDATION-ADOPTION.md) governs integration.
Use the [bounded tracks](PARALLEL_TRACK_BRIEFS.md), [source ownership matrix](SOURCE_OWNERSHIP.md)
and [runtime gap register](ADOPTION_AND_GAPS.md). Shared contracts merge before their
consumers; operator/evidence work can proceed against accepted fixtures. Other modules
may prepare read-only capabilities while Controller proves the complete receivables loop.
Operational memory promotion follows measured evidence and separate acceptance gates.
