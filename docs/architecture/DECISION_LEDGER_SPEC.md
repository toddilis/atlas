# Atlas Decision Ledger Specification v0.2

## Purpose

The Decision Ledger is the backbone of Atlas's ability to prove,
evaluate and improve its operating judgement.

Without it, Atlas can automate work but cannot reliably learn whether
its decisions were good.

## Required chain

`Observation → Decision → Approval → Action → Execution → Outcome → Evaluation → Learning Candidate`

Not every observation produces a decision. Not every decision produces
an action. Missing stages must remain explicit rather than fabricated.

## Observation record

Capture: - source - timestamp - subject - observed fact/data -
provenance - reliability/quality flags

## Decision record

Capture: - state known at decision time - triggering evidence - options
considered - recommendation - expected outcome - rationale -
assumptions - uncertainty - risk - applicable policy - model/rule
provenance

Never reconstruct the "state at the time" from current data when a
snapshot/reference can be preserved.

## Approval record

Capture: - approver - approved/rejected/edited - edits - timestamp -
authority/policy context

Operator edits are valuable preference evidence but not outcome
evidence.

## Action/execution record

Capture: - intended action - exact bounded parameters - idempotency
key - tool/provider - execution attempts - provider response - confirmed
state - failures/reconciliation - reversal where applicable

## Outcome record

Capture: - metric(s) the decision intended to influence - baseline -
evaluation window - observed result - relevant confounders - whether
result is known/unknown - evidence sources

## Evaluation

Possible evaluation dimensions: - execution correctness -
expected-vs-observed direction - magnitude - cost - reversals/disputes -
customer impact - financial impact - operational impact - confidence
that action contributed to result

Do not force causal certainty where only association is available.

## Learning output

Evaluation may create a `LearningCandidate`, but the memory system
decides whether it is inserted, reinforced, weakened, superseded or
rejected.

## Product surface

The operator should eventually be able to answer: - What did Atlas
decide? - Why? - What did I change? - What did Atlas do? - Did it
work? - What did Atlas learn from it?

## v0.2 implementation boundary

[Reference contracts](CONTRACT_IMPLEMENTATION.md) define the initial executable subset.
EVIDENCE-01 owns durable adoption coordinated with AUTHZ-02 and FLOW-01. Preserve
unknown outcomes with reason and no fabricated metrics. A generated invoice, confirmed
delivery and collected cash are separate observations; execution success does not
establish business benefit.
