# Atlas Memory & Learning Architecture v0.2

## 1. Purpose

Atlas must learn without turning every correlation, model statement or
operator approval into "truth."

The architecture adapts the strongest pattern from DIONE to an
organisational setting:

> **immutable operational evidence → episodic memory → semantic memory →
> procedural knowledge → governed operational use**

Governance/policy is deliberately separated from learned memory.
Learning may propose an authority change; it cannot enact one.

## 2. Foundational distinction

### Canonical operational state

Facts required to run the company belong in structured source-of-truth
state/read models.

Examples: invoice balance, inventory quantity, customer ID, PO status.

### Memory

Memory stores derived context and learned patterns that are useful but
are not primary operational truth.

Examples: - "Supplier A has recently missed promised lead time." -
"Campaigns using proof-led creative have performed better for this
audience under these conditions." - "Todd typically edits proposals of
this type toward a lower spend ceiling."

Memory must point back to evidence.

## 3. Memory layers

### Working memory

Short-lived context for the current reasoning/task. Not automatically
durable.

### Operational evidence

Immutable records of what was observed, proposed, approved, executed and
measured.

Evidence is not rewritten to fit later interpretations.

### Episodic memory

Evidence-backed summaries of specific events/episodes.

Example: "During Campaign X, demand for SKU Y increased 38% over the
comparison window and produced a stockout warning."

### Semantic memory

Generalised company knowledge derived from multiple episodes.

Example: "Paid campaigns for SKU Y can create stock pressure within its
current replenishment lead time."

Requires sufficient evidence, uncertainty metadata and revalidation.

### Procedural memory

A validated operating pattern that has repeatedly produced acceptable
outcomes within defined conditions.

Example: "When forecast stock cover falls below threshold X during a
validated demand spike, prepare purchase scenario Y and surface it for
approval."

Procedures remain bounded by deterministic policy.

### Governance memory / policy

Authority, legal constraints, risk limits, allowed tools and
operator-defined rules.

This is **not self-modifying learned memory**. Changes require an
authorised governance path.

## 4. Learning candidate lifecycle

1.  `OBSERVATION`
2.  `HYPOTHESIS`
3.  `CANDIDATE`
4.  `VALIDATED`
5.  `OPERATIONAL`
6.  `WEAKENED / SUPERSEDED / EXPIRED`

Promotion is controlled, evidence-backed and reversible.

## 5. Promotion gates

A candidate should not become durable operational knowledge unless Atlas
can answer:

1.  **Reality:** Is the underlying evidence trustworthy?
2.  **Relevance:** Could this knowledge change a future decision or
    improve an outcome?
3.  **Support:** Is sample size/evidence strength adequate for the
    claim?
4.  **Specificity:** Are conditions, population and scope defined?
5.  **Confounding:** Are obvious alternative explanations recorded?
6.  **Prediction:** Has the learning made useful predictions or guided
    decisions prospectively?
7.  **Outcome:** Did acting on it improve the intended business outcome?
8.  **Recency:** Is the evidence still representative?
9.  **Safety:** Can it be used within current governance and authority?

Not every item needs statistical proof, but uncertainty must be
explicit.

## 6. Memory item schema

``` text
memory_id
company_id
memory_type
claim
scope
conditions[]
evidence_refs[]
source_episode_refs[]
sample_size
effect_or_pattern
confidence
uncertainty
known_confounders[]
created_at
last_reinforced_at
last_verified_at
decay_policy
expires_at
status
supersedes[]
owner_or_domain
```

Confidence must not increase merely because the same generated claim is
repeated.

## 7. Deterministic extractors first

Early Atlas learning should prefer a small number of explicit, testable
extractors over unconstrained "agent learns everything" behaviour.

Examples: - recurring operator edits to the same proposal type -
supplier lead-time deviation - repeated decision/outcome relationship -
recurring service issue - repeated campaign/inventory interaction

The extraction mechanism can use AI to propose candidates, but
promotion/reconciliation rules are deterministic.

## 8. Reconciliation

New evidence may: - insert a new memory - reinforce an existing memory -
weaken it - narrow its scope - supersede it - contradict it - expire it

Contradiction must not be silently averaged away.

## 9. Decay and revalidation

Memory is not permanent by default.

Decay may depend on: - age - changing market conditions - changing
products/processes - lack of repeated evidence - contradictory
outcomes - model/integration changes

High-impact procedural knowledge should have explicit revalidation
requirements.

## 10. Learning ledger

Operators should eventually be able to inspect:

-   what Atlas learned
-   evidence supporting it
-   confidence/uncertainty
-   where it is being used
-   what Atlas weakened or unlearned
-   why a procedure was promoted
-   whether a learning changed decisions
-   whether those decisions improved outcomes

This is both a trust feature and a product differentiator.

## 11. Non-learning reasons

Atlas should explicitly record why an event did **not** become memory,
for example: - insufficient evidence - duplicate - no decision
relevance - confounded - outcome unavailable - stale - policy prohibits
use - contradictory evidence - low-quality source

Garbage control is an architectural feature, not a prompt instruction.

## v0.2 delivery gate

EVIDENCE-01 captures the chain and unknown outcomes first. Operational memory promotion
is a later bounded task requiring evidence-strength, contradiction, decay and prospective
validation cases. Existing approval-derived facts remain preference evidence and cannot
grant authority or serve as proof of business value. Review the
[adoption gaps](ADOPTION_AND_GAPS.md) before enabling learned procedures.
