# ADR-003 --- Agent teams inside Atlas modules

**Status:** Proposed\
**Date:** 2026-11-02

## Context

Atlas modules are deterministic code. Claude runs in two read-only places, the daily
briefing narration and the console assistant, and both stay off until their grants and
key are set. Deterministic code is the right owner of money, quantities, state, due dates
and postings. This ADR does not change that.

Much of the work on the module map is judgment and language, not arithmetic: reading
customer replies, explaining a blocked invoice, proposing a bank-line code, drafting
outreach, writing campaign content, triaging an inbox. The roadmap reaches the modules
where that work dominates last: Marketer is 5th, Concierge 6th, and Creative, Brand Brain
and Product & Market Intelligence are unscheduled. Each waits for its deterministic core.

The other pattern is Claude agent teams defined by prompts, run on existing connectors,
with a human doing the send step. It delivers language work in days. Run outside Atlas,
though, it has no audit trail, keeps state in spreadsheets, lets the model do arithmetic,
and produces the disconnected per-department agents that ADR-001 rejects.

## Decision

A module may have two parts:

1. **Deterministic core** (unchanged). It owns state, money, quantities, due dates,
   matching, postings and side effects.
2. **Agent team** (new). It is made of Claude members, defined as versioned business
   configuration, that do judgment and language work at the module's edges. Members read
   through whitelisted read tools and write only proposals.

Agent teams are a platform capability, like the assistant, and not a new kind of module.
They follow ADR-001: members do not converse with each other in hidden ways, and they
share context only through read-models, proposals and events.

### What a member is

| Part | Definition |
| --- | --- |
| Definition | Module, purpose, system prompt, model, read tools, propose tools, output schema, authority ceiling, trigger (event or schedule), monthly spend cap |
| Version | Any change creates a new version, as with price books. Every proposal records the version that made it |
| Read tools | Bounded, business-scoped selects over read-models. Code records each one as a citation, as the assistant already does. No write tools |
| Propose tools | Create a proposal: a typed draft (mapping, coding, classification, message, plan) addressed to an existing deterministic tool or to the operator. Registered in the tool registry with grants; default risk `approve_required` |
| Validators | Deterministic checks on every proposal before anyone sees it: output schema; grounding (every number and record id must appear in what the member was shown, per `assistant/grounding.ts`); module recompute (the core re-derives any amount, quantity or date the proposal relies on); eligibility rules. A failing proposal is held with its reason |
| Evals | A fixture set for each member. A version can be activated only after its evals pass. CI replays recorded model outputs through the validators; live evals run on demand within a stated budget |

### Authority

A member holds at most PREPARE on the authority ladder. A proposal becomes an effect only
when the operator approves it. The approval then invokes an existing deterministic tool
through the normal policy gate, with exact-action binding. A member moves above PREPARE
only through the existing governance path: evidence-backed outcomes plus an authorized
decision. Approval counts alone are not enough (PLAN §2).

### The three-role pattern, mapped

The team shape that works outside Atlas has four roles: one agent reconciles, one drafts,
one checks, and a human sends. Inside Atlas, only the drafting role remains a model.

| Role | Outside Atlas | Inside Atlas |
| --- | --- | --- |
| Reconcile and compute | Claude agent | Deterministic core |
| Draft and judge | Claude agent | Agent team member |
| Check | Claude agent | Deterministic validators; optionally a model reviewer for tone, never for figures |
| Send or commit | Human | Operator approval, then a deterministic tool |

### Where agent teams sit

| Module | Deterministic core | Agent team |
| --- | --- | --- |
| Controller | Pricing, invoice parts, receipt matching, ageing, reminder figures | Triage of blocked drafts (proposed SKU, retailer, price or freight mappings); explanations of ambiguous bank matches; classification of customer replies (paid, query, dispute); reminder wording over the fixed snapshot |
| Quartermaster | Balances, movements, reorder quantities | Anomaly explanations, supplier email drafts, demand narrative |
| Bookkeeper | Journals, close, GST figures | Proposed codes for uncoded bank lines |
| Rep | Order cadence, dormancy detection | Reorder nudges, account research, onboarding drafts |
| Marketer, Creative, Brand Brain | Audiences, stock and price constraints, attributed results | Campaign, email, social and blog drafts in the brand voice |
| Concierge | Order, shipping and refund calculations | Inbox triage, reply drafts, return proposals |
| Executive | Cross-module rollups | Weekly brief synthesis |

Language-led teams (Rep, Marketer, Creative, Concierge) need only read-models and the
proposal path, so they can start before their module's core is complete. A team cannot
create the state its core will own. Until that core exists, its proposals go to the
operator to act on and are not executable.

## Invariants added

1. A member never posts to the ledger, changes a state machine or calls a mutating tool
   directly. Its only write is a proposal.
2. Each figure in a proposal is grounded in what the member was shown, or recomputed by
   deterministic code. If it is neither, the proposal is held.
3. Member definitions and prompts are versioned business configuration, audited like
   price books. Changing one needs no code deployment.
4. Every member ships with evals, and an unevaluated version cannot be activated.
5. Each member has a spend cap per business, checked before any model call. Pausing
   business actions pauses every team.
6. Members do not message each other. Effects between teams travel only through
   proposals, read-models and events.
7. Operator edits and rejections are preference evidence under the memory architecture.
   They never confer authority.

## Sequencing

This does not displace the current build queue. Controller go-live comes first:
deployment, the Wise/ASB sample and the activation cutoff. After that:

1. [AGENT-01](../../development/tasks/AGENT-01.md): the agent-team runtime, with one
   Controller member that triages blocked invoice drafts.
2. AGENT-02: Controller reply classification and reminder wording.
3. AGENT-03: the first language-led team for a later module (Rep or Marketer, the
   owner's choice), proposals only.

Receivables from before the activation cutoff stay outside Atlas
([VICE_RECEIVABLES](../../product/VICE_RECEIVABLES.md), Coverage). A temporary agent team
outside Atlas may clean them up, and it retires at the cutoff. Any opening balances it
produces enter Atlas only through a deterministic import that the operator approves.

## Consequences

### Positive

- AI-heavy work arrives without waiting for each module's core.
- The money boundary is unchanged.
- All work shares one audit trail and one approvals queue.
- Operator edits become evidence for later authority decisions.
- Teams compound inside Atlas instead of becoming silos.

### Costs

- Model spend, budgeted per member.
- An eval fixture set for every member.
- Version management for member definitions in the console.
- More items in the approvals queue, so proposals need batching and filtering.
- An optional model reviewer, which adds cost.

## Rejected alternatives

- **Claude limited to narration until each module ships.** This delays, by months,
  the work where models add most value.
- **Agent teams outside Atlas indefinitely.** No audit trail, spreadsheet state, model
  arithmetic and silos.
- **Members calling mutating tools within policy caps from day one.** This contradicts
  "autonomy is earned" (PLAN §11).
- **A general multi-agent framework or an orchestrator agent.** It introduces hidden
  agent-to-agent conversation (ADR-001). The worker's job runner already sequences
  members.

## Owner decisions needed

1. Accept this ADR. Acceptance adds PLAN decision D19.
2. Decide whether language-led teams may start before their module's core. This changes
   only when proposals arrive, not the D6/D18 module build order.
3. Choose the first language-led team: Rep or Marketer.
4. Set the monthly model budget for agent teams per business.
