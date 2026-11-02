# AGENT-01 --- agent-team runtime, with Controller draft triage as its first member

[ADR-003](../../architecture/ADRs/ADR-003-AGENT-TEAMS.md) proposes agent teams inside
modules. This task builds the runtime and proves it with one Controller member. It starts
only after ADR-003 is accepted and the Controller go-live steps in the build queue are
done.

## User outcome

When an invoice part draft is blocked by a missing or conflicting mapping (retailer, SKU
price, freight rule or terms), the operator sees a proposed fix beside the block. The
proposal comes with its evidence and the records it was based on. Approving it applies
the fix through the existing catalogue or pricing tool, and the draft is retried.
Rejecting it records the reason. Nothing changes without approval, and the cost of every
run is recorded.

## Verified starting gap

- A blocked invoice part draft job records its reason in the jobs console. The operator
  diagnoses and fixes the mapping by hand.
- Claude runs only in briefing narration and the read-only assistant. No path exists for
  a model proposal, and nothing writes `approvals.proposed_summary` from a model.
- `assistant/grounding.ts` and the assistant's whitelisted, citation-recording read tools
  exist and can be reused.

## Scope and slices

### AGENT-01a --- member definitions and versions

- Members and immutable member versions, scoped to the business: module, purpose, system
  prompt, model, read tools, propose tools, output schema, authority ceiling (at most
  PREPARE), trigger and monthly spend cap.
- A version activates only with a recorded eval pass for that exact version. Activation
  and deactivation are audited.
- Console: a read-only list of members, their active version and month-to-date spend.

### AGENT-01b --- runtime

- A worker job kind runs one member against one subject. Before any model call, it checks
  the grant, business pause and spend cap. If any check fails, it records why and spends
  nothing.
- A bounded tool loop with whitelisted read tools only. Code records each call as a
  citation. Turns and tokens are capped. The run must end in exactly one propose call
  that matches the output schema.
- Tokens, cost, model and member version are stored per run. If the model is unavailable,
  the run retries under job policy and the block stays as it is.

### AGENT-01c --- proposals and validators

- Proposals are stored with: member version, subject, payload, citations, validator
  results and a state (`held`, `pending`, `approved`, `rejected`, `expired`, `applied`).
- Validators run in this order:
  1. Schema.
  2. Grounding: every number and record id must appear in the cited rows.
  3. Recompute: the pricing resolver re-resolves the blocked draft with the proposed
     mapping, and the result must be complete and consistent.
  4. Eligibility.
- A failure holds the proposal with its reason. A passing proposal enters the approvals
  queue as `approve_required`, carrying the member's summary.
- Approval invokes the existing deterministic catalogue or pricing tool under
  exact-action binding, then wakes the blocked job. A rejected fix is not proposed again
  for the same block (deduplicated by fingerprint).

### AGENT-01d --- evals

- At least five fixture cases:
  1. A missing SKU price.
  2. An unknown retailer.
  3. Conflicting price-book entries.
  4. A missing freight rule.
  5. A case where the correct output is a question for the operator, not a fix.
- CI replays recorded model outputs for each case through the validators.
- A separate command runs live evals within an explicit budget and records the pass
  against the version.

## Acceptance cases

- With the grant off, actions paused or the cap reached, no model call is made and the
  job records why.
- A proposal that introduces a number not in its cited rows is held, and its reason is
  shown.
- A proposal whose fix does not resolve the block on recompute is held.
- Approval executes the existing tool exactly once. A parameter changed after approval
  invalidates that approval.
- A rejection stores its reason, and the same fix is not re-proposed for that block.
- Changing a prompt creates a new version, and earlier proposals keep their original
  version.
- Member versions, runs and proposals are business-scoped, and the tenant probe covers
  them.
- If the model is unavailable, the operator can still fix the block by hand as today.

## Out of scope

Customer-facing messages, authority above PREPARE, members for other modules, and a model
reviewer.

## Inputs needed

- Owner acceptance of ADR-003.
- The monthly model budget for agent teams.
- `ANTHROPIC_API_KEY` set in the worker environment (the client already reads it).
