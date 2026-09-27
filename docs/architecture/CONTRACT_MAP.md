# Atlas Contract Map v0.2

## 1. Purpose

The Contract Map is the common language between Atlas modules. It
prevents parallel teams from inventing incompatible representations and
makes cross-functional intelligence possible.

Contracts are versioned. Breaking changes require an ADR or explicit
migration plan.

## 2. Canonical object families

Initial shared objects:

-   `Company`
-   `Person`
-   `Customer`
-   `Account`
-   `Supplier`
-   `Product`
-   `SKU`
-   `Order`
-   `OrderLine`
-   `Invoice`
-   `Payment`
-   `InventoryPosition`
-   `PurchaseOrder`
-   `Shipment`
-   `Campaign`
-   `CreativeAsset`
-   `Lead`
-   `Opportunity`
-   `ServiceCase`
-   `Risk`
-   `OpportunitySignal`
-   `Observation`
-   `Decision`
-   `Approval`
-   `Action`
-   `Execution`
-   `Outcome`
-   `MemoryItem`
-   `Policy`
-   `Experiment`

Each object must include stable identity, tenant/company identity,
source/provenance where relevant, timestamps, lifecycle state and
versioning/concurrency semantics where required.

## 3. Universal event envelope

Every canonical event should carry, at minimum:

``` text
event_id
event_type
event_version
company_id
occurred_at
observed_at
producer
subject_type
subject_id
correlation_id
causation_id
source_refs[]
payload
evidence_refs[]
```

Events describe facts or explicitly labelled detections/proposals. Do
not disguise model inference as observed fact.

## 4. Event classes

### Operational fact

Examples: - `OrderCreated` - `PaymentReceived` - `InventoryAdjusted` -
`InvoiceOverdue` - `ShipmentReceived`

### Detection

Examples: - `StockoutRiskDetected` - `CashRiskDetected` -
`DemandSpikeDetected` - `CustomerIssuePatternDetected` -
`CompetitorMoveDetected`

Detections require evidence and confidence/uncertainty metadata where
probabilistic.

### Decision lifecycle

-   `DecisionProposed`
-   `DecisionRevised`
-   `DecisionApproved`
-   `DecisionRejected`
-   `DecisionExpired`

### Action lifecycle

-   `ActionPrepared`
-   `ActionAuthorised`
-   `ActionExecutionStarted`
-   `ActionExecutionConfirmed`
-   `ActionExecutionFailed`
-   `ActionReconciliationRequired`
-   `ActionReversed`

### Outcome lifecycle

-   `OutcomeWindowOpened`
-   `OutcomeObserved`
-   `OutcomeEvaluated`

### Learning lifecycle

-   `LearningCandidateCreated`
-   `MemoryPromoted`
-   `MemoryReinforced`
-   `MemoryWeakened`
-   `MemorySuperseded`
-   `MemoryExpired`
-   `ProcedureCandidateCreated`

## 5. Decision contract

A decision must preserve:

``` text
decision_id
company_id
decision_type
subject_refs[]
trigger_refs[]
state_snapshot_ref
options_considered[]
recommended_option
expected_outcomes[]
rationale
assumptions[]
uncertainties[]
risk_class
policy_refs[]
model_or_rule_provenance
created_at
expires_at
```

A decision is not an action.

## 6. Approval contract

``` text
approval_id
decision_id
requested_authority
approver
approved | rejected | edited
operator_edits
reason_optional
policy_snapshot_ref
timestamp
```

Approval captures operator preference/authorisation. It is not proof
that the recommendation was good.

## 7. Action contract

``` text
action_id
decision_id
action_type
tool
target
parameters
risk_class
required_authority
idempotency_key
policy_snapshot_ref
prepared_at
authorised_at
execution_state
```

## 8. Outcome contract

``` text
outcome_id
decision_id
action_ids[]
measurement_window
metrics_before
metrics_after
expected_outcomes[]
observed_outcomes[]
confounders[]
evaluation
evidence_refs[]
measured_at
```

## 9. Initial cross-module subscriptions

  ----------------------------------------------------------------------------------------
  Producer signal                          Consumers               Purpose
  ---------------------------------------- ----------------------- -----------------------
  Marketer: `DemandSpikeDetected`          Quartermaster,          inventory exposure,
                                           Controller, Executive   working capital,
                                                                   priority

  Quartermaster: `StockoutRiskDetected`    Marketer, Rep,          throttle/promote
                                           Commerce, Executive     alternatives, account
                                                                   comms

  Controller: `CashRiskDetected`           Quartermaster,          constrain
                                           Marketer, Executive     spend/purchasing

  Concierge:                               Product Intel,          identify
  `CustomerIssuePatternDetected`           Commerce, Executive     product/operational
                                                                   defects

  Product Intel: `CompetitorMoveDetected`  Brand, Marketer,        evaluate
                                           Executive               positioning/campaign
                                                                   response

  Rep: `CommercialDemandSignalDetected`    Quartermaster,          purchasing and demand
                                           Marketer, Executive     planning

  Creative:                                Brand, Marketer,        validate reusable
  `CreativePerformanceLearningCandidate`   Learning Engine         creative knowledge
  ----------------------------------------------------------------------------------------

This table is a seed, not an exhaustive hard-coded graph.

## 10. Contract governance

The Integration Architect must review: - new canonical entities - new
event types - duplicate concepts - breaking schema changes -
module-specific fields leaking into core - direct module-to-module
coupling - inconsistent identity/provenance - missing outcome/evidence
linkage

## 11. Executable subset and precedence

The field lists above describe the target conceptual model, not complete wire schemas.
[Contract implementation](CONTRACT_IMPLEMENTATION.md) defines the executable v1 subset,
required fields, exact money representation, compatibility and event mappings. Its schemas
are authoritative for that subset; other families remain planned. Approval additionally
binds company, action and decision revisions, immutable intent, expiry and revocation.
Execution is a separate per-attempt record defined by the
[execution specification](EXECUTION_AND_APPROVAL_SPEC.md). Envelopes require connection
identity and subject version as described by [event delivery](EVENT_DELIVERY_SPEC.md).
