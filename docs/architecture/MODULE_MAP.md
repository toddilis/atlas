# Atlas Module Map v0.2

## Purpose

Define the initial functional organisation of Atlas without turning
modules into silos.

A module owns domain-specific reasoning, workflows and views. Shared
state, policy, evidence, memory, tools and contracts remain platform
concerns.

## Atlas Executive / Orchestrator

**Mission:** Cross-company situational awareness and coordinated
operating priorities.

Consumes signals from all modules. Produces executive briefs,
cross-domain decision packages, conflicts, priorities and escalations.

It does not silently override specialist modules or policy.

## Controller --- Finance

**Mission:** Maintain financial operating truth and improve financial
control.

Initial responsibilities: - invoices, receivables and payables - payment
workflows - cash visibility - reconciliation - financial exceptions -
spend/cash risk - financial proposals and approvals - later:
forecasting, scenario analysis and management reporting

Controller is the first vertical slice and should establish reusable
evidence, approval, execution and recovery patterns.

## Quartermaster --- Supply / Inventory / Purchasing

**Mission:** Ensure the right inventory is available at acceptable
working-capital and supply risk.

Responsibilities: - inventory position - stockout/overstock risk -
purchasing proposals - supplier performance - lead times - reorder
logic - shipment/receiving exceptions - demand/inventory cross-signals

## Rep --- Sales / Accounts

**Mission:** Grow and manage commercial relationships.

Responsibilities: - leads/opportunities - wholesale/accounts -
pipeline - follow-up - quotes/proposals - account context - relationship
memory - commercial next-best actions

## Marketer --- Demand Generation

**Mission:** Generate measurable demand and learn what creates
profitable growth.

Responsibilities: - campaign planning - channel execution proposals -
audience/offer testing - performance analysis - attribution-aware
learning - content distribution - demand signals for other modules

## Brand Brain

**Mission:** Preserve and evolve company-specific brand intelligence.

Brand Brain is primarily a **company intelligence/configuration layer**,
not generic Atlas Core.

Domains include: - brand identity/core - voice - visual DNA - customer
understanding - positioning - product knowledge - claims/evidence
registry - competitors/market - creative learnings - campaign
learnings - experiments - governance

For VICE, the Brand Brain becomes the durable source of brand truth
consumed by Marketer, Creative and other relevant modules.

## Creative

**Mission:** Turn strategy and brand constraints into production-ready
creative work.

Responsibilities: - creative direction - copy - design briefs - video
concepts - asset variants - creative QA - performance feedback into
creative learning

Suggested internal loop: Research → Strategist → Creative Director →
Copy/Design/Video → Publisher → Analyst → Learning.

## Commerce / E-commerce Operations

**Mission:** Operate the commercial storefront and merchandising layer.

Responsibilities may include: - catalogue hygiene - merchandising -
pricing/promotion proposals - conversion issues - onsite content -
launch coordination - e-commerce operational exceptions

This may initially live across other modules but should be treated as a
defined capability boundary.

## Concierge --- Customer Operations

**Mission:** Protect and improve the customer experience.

Responsibilities: - support/service cases - order issues -
returns/refunds proposals - customer communications - recurring issue
detection - escalation - voice-of-customer signals

## Registrar --- People / Administration / Compliance

**Mission:** Own structured administrative obligations and company
records that do not belong to another operating module.

Potential responsibilities: - recurring filings/renewals - company
records - policies/process records - onboarding/offboarding workflows -
administrative deadlines - compliance evidence

Scope must remain explicit as Atlas matures.

## Product & Market Intelligence

**Mission:** Continuously convert customer, competitor, market and
internal evidence into product/commercial insight.

Responsibilities: - competitor monitoring - market changes - customer
research synthesis - product opportunity hypotheses - product
performance evidence - claims/science evidence where relevant -
experiment proposals - cross-signals to Brand, Marketer, Quartermaster
and Executive

## Shared Company Brain

Not a department. It is common infrastructure for evidence-backed
organisational memory.

No module owns private durable truth that other authorised modules
cannot discover through canonical interfaces.

## Cross-module rule

Modules do not create bespoke direct integrations with one another when
a canonical event/object can express the relationship.

Any new cross-module dependency must be declared in the Contract Map and
reviewed by the Integration Architect.
