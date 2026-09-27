# Atlas Core vs Company Configuration v0.2

## Purpose

VICE is Customer Zero, but Atlas must not become "VICE's internal
codebase with SaaS branding."

Every capability must have an explicit product boundary.

## Atlas Core

Reusable product machinery belongs in Core:

-   canonical contract framework
-   event spine
-   read-model/projection infrastructure
-   decision/action/outcome ledger
-   policy engine
-   approvals
-   audit/evidence
-   tool execution
-   idempotency/recovery
-   memory/learning engine
-   authority model
-   operator surfaces
-   connector framework
-   module interfaces
-   evaluation/telemetry

## Company configuration

Customer-specific operating choices belong in configuration:

-   thresholds
-   monetary caps
-   authority settings
-   channels
-   enabled modules
-   supplier/customer rules
-   escalation preferences
-   operating hours
-   company terminology
-   account mappings
-   workflow toggles

## Company intelligence

Company-specific knowledge belongs in tenant-scoped intelligence/memory:

-   brand identity
-   tone/voice
-   visual DNA
-   products
-   customers
-   competitors
-   evidence/claims
-   supplier context
-   relationship history
-   learned company patterns
-   validated procedures

VICE's Brand Brain is therefore company intelligence running on Atlas
machinery.

## Integration adapters

Provider-specific code should sit behind stable interfaces wherever
practical.

Examples: - Shopify - Xero - Stripe - Klaviyo - 3PLs - ad platforms

Business modules should request capabilities, not scatter provider
assumptions through domain logic.

## Test

Before merging a feature, ask:

> "Could a second company use this mechanism by changing configuration,
> mappings and company knowledge rather than forking the code?"

If no, either: 1. it is intentionally a company-specific extension, or
2. the abstraction boundary is wrong.

Both are acceptable only when explicit.
