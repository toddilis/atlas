# Atlas product: many businesses, one maintained platform

PLAN decision D12 records the product direction: Atlas is intended for many types of
business. VICE is the first configured deployment and validation customer. Its
workflow is a reference implementation, not the definition of the entire product.
This is an architecture and delivery contract, not a claim of existing multi-business
support. It applies to work now, rather than waiting for a later rewrite.

## Product boundaries

| Layer | Owns | Examples |
| --- | --- | --- |
| Shared platform | Business identity, users/roles, permissions, audit, events, durable work, approvals, assistant context and console shell | A business-scoped approval/retry works the same way for each installed module |
| Optional business modules | Domain data, deterministic rules, actions and operator screens | Controller, inventory/Quartermaster, Rep, Marketer, Concierge, Registrar |
| Integration adapters | Provider authentication, source IDs, mapping, capabilities, retries and reconciliation | Shopify, carrier, bank/accounting and messaging connections |
| Business configuration and templates | Enabled modules, branding, terminology, roles, prices, taxes, currencies/units, terms, approval limits, locations, suppliers and workflows | VICE's partial-shipment numbering, retailer agreements and GoSweetSpot charging policy |

Supported variation is handled through validated, versioned configuration. A genuinely
new business capability may need a reusable module/adapter extension with tests; it
must not become a customer-specific fork or an unreviewable universal rule engine.
Industry templates are optional starting configurations. Their supported capabilities
and limitations must be explicit; they do not make every industry supported by default.

## Requirements for every new slice

- Explicit business context travels through requests, database operations, events,
  jobs, retries, approvals, external idempotency keys and audit. Derive authority from
  authenticated membership or a trusted job/connection binding, not a caller's business ID.
- Keep each business's users, records, secrets, configuration, assistant memory/search
  and spending limits isolated. Namespace caches, files, deduplication and provider
  identities by business and connection. Logs and support tools respect the same boundary.
- Enforce authorization at the server/database boundaries. Organization columns or
  client-side filters are not proof of isolation; service-role database access needs
  explicit controls and boundary tests.
- Enable modules by business capability. A service business can omit physical stock,
  shipping and Quartermaster without supplying fake SKUs, locations or fulfillments.
  Disabling a module removes its scheduled/action surface and preserves audit/history.
- Shared interfaces use Atlas identities and business events. Provider-specific payloads
  stay in adapters with their source mapping retained. Shopify is VICE's current source,
  not a mandatory prerequisite for every Atlas customer.
- Configure currency, supported tax treatment, units, timezone, calendar terms, invoice
  numbering, approval roles and delivery policy. Preserve versioned calculation/approval
  snapshots. Unsupported regional rules or workflows remain explicitly unsupported.
- Keep branding and business-specific defaults in configuration/templates. New customers
  should not need source edits, a separate product branch or copied UI pages to apply
  supported settings. Adding a new provider may require a reusable adapter.
- Version schemas, events, adapter contracts and configuration. Shared upgrades must
  preserve each business's settings and historical records; rehearse migration/recovery.

The current global `ATLAS_ORG_ID`, cached service-role client and environment-based
Shopify location routing are single-deployment implementation constraints to address.
Do not silently reuse those assumptions in a shared multi-business service. Keep a
single-business pilot explicitly scoped until the isolation gate below passes.

## Delivery gates

| Gate | Timing | Required evidence |
| --- | --- | --- |
| PLAT-01: business context and source contracts | During foundation and every affected new slice | Explicit business/connection identity, server-side authority, source-independent domain contracts and tests rejecting cross-business references; DATA-01 and pricing must meet this for their own surfaces |
| CONFIG-01: reusable setup | With catalogue/pricing and module setup | Operator creates a business profile, chooses modules and configures supported rules/branding/connections; configuration is versioned and missing capabilities are visible |
| PORT-01: different-business proof | Early, after catalogue/pricing; extend with the first complete workflow | Synthetic VICE-like wholesale profile plus a non-stock service profile use the same codebase with different modules, terminology and rules; the latter can onboard and preview supported pricing without Shopify, inventory or shipping |
| TENANT-01: isolation and lifecycle | Before a second real business shares an environment, including a test environment containing real data | Membership/role isolation, direct API and database denial, worker/retry/webhook binding, search/memory/cache/file isolation, separate secrets, usage limits, business-specific export/offboarding and restore rehearsal |
| PILOT-02: second customer | After relevant workflow, portability and isolation gates pass | A deliberately scoped different business completes its supported workflow through setup; gaps become reusable capabilities with explicit scope, not a copied VICE installation |

PORT-01 is a synthetic product-design test, not evidence that all service workflows
are built. Extend its cases as Controller and later modules become usable. A second
real customer need not wait for all twelve VICE segments: it needs the modules its
declared workflow requires and the relevant product/operating gates.

## Boundary acceptance examples

- Two businesses may use the same SKU, order number and provider event ID without
  collisions or shared prices, invoice counters or replay effects.
- A member of business A cannot read, approve, alter or retrieve business B's records
  through the UI, direct API, a substituted identifier, export or assistant query.
- A worker or delayed retry for A cannot execute using B's credentials, pricing,
  policy or business context after a process restart or configuration change.
- A profile without inventory/shipping can use its installed capabilities without
  a Shopify connection or fabricated stock records. Disabled modules cannot run tools
  or jobs merely because another business enabled them.
- Changing A's prices, invoice template or approval policy leaves B and historical
  invoices unchanged. An upgrade preserves both profiles and their configuration versions.
- Disconnecting a provider or suspending a business stops relevant future actions
  and exposes pending/uncertain outcomes for reconciliation without erasing history.

## Effect on the existing roadmap

The twelve delivery segments remain a useful first-customer path. Business context,
configuration, adapters and isolation are a continuing product track within them.
Controller and Quartermaster remain reusable modules; businesses select the modules
and supported workflows they need. Their order for VICE does not become mandatory
onboarding for every customer.

DATA-01 remains the next domain slice and must establish its portion of PLAT-01.
PRICING-01 remains the next new operator-facing feature and must support separate
business configurations. Do not postpone these boundaries until a later tenancy
project, and do not halt concrete VICE delivery to build an abstract plugin marketplace.
