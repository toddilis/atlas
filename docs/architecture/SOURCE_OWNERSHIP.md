# Source ownership and freshness

An Atlas read model is a normalized view with provenance, not permission to silently
override the source. Record source version, occurred/observed time, last successful sync,
mapping version and quality. Freshness limits are business/workflow configuration;
missing required limits or source coverage block dependent consequential actions.

| Data | Authoritative source / owner | Atlas behavior on conflict or staleness |
| --- | --- | --- |
| VICE order and successful dispatch lines | Configured Shopify connection and supported fulfillment status; DATA-01 | Preserve order-line/dispatch identity, cancelled/corrected history and invoice allocations; stale or conflicting eligibility blocks new billing |
| Product prices, retailer agreements and customer freight rules | Versioned Atlas configuration maintained by entitled operator; PRICING-01 | Explicit precedence and effective date; missing/conflicting rules block; never infer a free price or freight charge |
| Carrier freight cost | Configured GoSweetSpot evidence/adapter | Keep separate from customer charge; actual-cost policies require matched evidence |
| Approved invoice content and terms | Immutable Atlas invoice/document snapshot for supported workflow | Later configuration changes do not rewrite history; repricing creates revision and invalidates approval |
| Delivery status | Declared connector evidence or local artifact generation | Keep generated, accepted and delivered distinct; unknown remains unresolved |
| Bank transaction identity and settlement evidence | Confirmed Wise/ASB import or feed, still to be configured | Preserve source transaction IDs; repeat import is idempotent; ambiguous/amount-only matches need an owned exception |
| Accounting balances/postings | Accounting system and handoff contract still to be confirmed | Do not assume Atlas or Stripe owns final accounting truth; live completion blocked until owner/source agreed |
| Authority, caps, tool grants and pause | Authorized governance configuration | Current checks at execution; memory cannot override |
| Memory and learned patterns | Derived Atlas evidence-backed knowledge | Never substitute for current quantities, balances, policy or provider confirmation |

Missing bank-feed/accounting choices do not block synthetic fixtures, pricing editor or
source-independent contracts. Do not invent production values. New shipments remain
the pilot scope; no historical opening-balance migration is introduced here.

The source adapter normalizes identities and declares capability/freshness; domain owners
resolve semantic conflicts through an operator-visible exception with evidence. Source
disconnect stops dependent actions while preserving audit and pending reconciliation.
