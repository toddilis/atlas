# PRICING-01 - adaptable product and shipping pricing

Status: implementation contract, not completed functionality. PLAN decision D10
records the owner's requirement for adaptable pricing. The feature design below
provides configurable capabilities; it does not assert any particular commercial
rate, discount, shipping policy or tax treatment is approved for live use.

## User outcome

The operator can maintain prices and shipping agreements inside Atlas, preview what
a retailer will be charged, and handle a one-off exception during invoice review.
Changing a commercial rule does not require a code deployment. Existing approved
invoices retain their agreed amounts and remain explainable.

## Starting point and scope

Read `src/platform/pricing/resolve.ts`, `types.ts`, `tax.ts`, the core/billing
migrations, `draft_invoice.ts`, current grants/approval paths and console auth work
before implementation. Existing code selects an effective account-bound price book
or an active default book and resolves unit prices by product. Extend this foundation
instead of building a second disconnected resolver. The current draft path still
uses order quantities; DATA-01/BILL-01 own dispatch allocation repair.

Deliver the persisted configuration, deterministic resolver/preview, protected
editing API and usable console journey together. BUILD-01 provides the verification
environment. AUTH-01/AUTHZ-01 are prerequisites for protected editing, and invoice
approval integration must use AUTHZ-02's bound subject. Synthetic configuration is
sufficient to develop and test the feature; live business values are set at onboarding.

## Product pricing

- Maintain named price books with exact SKU/product mapping, currency, explicit tax
  basis, effective dates and a version history. Validate duplicate/missing mappings,
  invalid ranges and unsupported money values before activation.
- Assign a retailer to a price book and record retailer-specific negotiated prices
  or discounts. Support explicit percentage or fixed-amount discounts and quantity
  tiers as configured rule types. Record their scope and calculation order.
- The configuration defines precedence, fallback and whether discounts may combine.
  Show them in the preview. Conflicting equally applicable rules block activation
  or calculation; never silently select the first row or stack discounts.
- Make the pricing-date basis explicit (for example, order or dispatch date), with
  an effective timezone and exact interval boundaries. Quantity-tier rules likewise
  specify whether eligibility uses ordered or dispatched quantity; split dispatches
  must not accidentally lose an agreed order-volume price.
- Import the existing workbook into a draft price book with a mapping/difference
  preview. Import is not automatic activation, and must not overwrite negotiated
  prices or historical invoice snapshots. Real private source files do not belong
  in public repository fixtures.

## Shipping pricing

- Keep the carrier cost/quote separate from the customer freight charge. Preserve
  provider shipment/quote identity, source time, currency and tax basis when available.
- Offer configured charge modes: actual carrier cost, actual cost with a fixed or
  percentage adjustment, fixed charge, free shipping, and a manually set charge.
  Mode availability does not select a default business policy.
- Rules may be scoped to a retailer or destination and use an order-value threshold.
  Threshold configuration states whether its basis includes discounts/tax and uses
  whole-order or dispatched value. Do not infer an address zone or missing amount.
- Store the partial-dispatch charging basis explicitly: per dispatch or an order-level
  charge with an allocation schedule. Record already allocated freight and preserve
  its total across A/B invoices. Repeated events or a later rule version cannot
  charge the same allocation again. Changes follow a visible correction path.
- Actual-cost rules require valid cost evidence. Missing/expired quotes, unknown tax
  basis or currency mismatches produce an exception. Manual/free/fixed-charge modes
  are explicit choices and must not disguise missing cost as a known zero.
- Support a reasoned manual price/freight override on a draft, including a deliberate
  zero charge. An override does not silently change the retailer's future agreement.

## Operator journey and calculation record

1. Open pricing settings, create/edit a draft price book or shipping rule and choose
   its retailer scope and effective date.
2. Preview a selected retailer/order/dispatch. Show base price, selected rule/version,
   discount, quantity, unit/line amounts, carrier cost, customer freight, tax and total.
   Explain missing data or conflicts and show before/after differences.
3. Activate a validated version through the authenticated, entitled policy path.
   Record actor, time, old/new version and reason. Concurrent edits must not overwrite
   one another silently; reject a stale version and preserve the draft for resolution.
4. Generate the invoice from a persisted calculation snapshot. Store source identities,
   inputs, pricing timestamp/basis, rule versions, override reasons, rounding policy,
   tax inputs and amounts. Use deterministic minor-unit/decimal arithmetic.
5. Review/approve the invoice with its exact prices and freight. A retry or reprint
   uses the snapshot. Global rule changes do not rewrite existing invoices. An explicit
   draft reprice shows a diff and requires fresh approval if material terms change.

The preview and drafting paths must share the same calculation implementation.
Detect stale source/configuration when applying a preview; do not save different
amounts under the earlier preview's identity. Models may explain or propose changes
but do not calculate money or activate pricing without the configured authority.

## Acceptance cases

| Case | Evidence required |
| --- | --- |
| Same SKU, two retailers | Different configured agreements produce the expected amounts and explanations |
| Discount plus negotiated price or tier | Configured precedence/combination is honored; conflicting rules are rejected |
| Scheduled price change | Before/at/after effective boundaries select the correct version; an approved invoice remains unchanged |
| Partial 40/60 dispatch with an order-volume tier | Eligibility uses the configured quantity basis and invoice quantities remain 40/60 |
| Unknown SKU or missing retailer rule | Visible unresolved draft; no approximate match or unauthorized fallback |
| Actual, adjusted, fixed, free and manual shipping | Each mode yields its independently calculated expected charge and retains known/unknown carrier cost separately |
| Free-shipping threshold | Below/at/above boundary uses the configured discounted/tax/value basis |
| Split freight and repeated event | Allocated parts sum to the agreed charge and a replay adds no duplicate allocation |
| Missing/expired cost or mismatched currency | Relevant charge remains unresolved; no silent zero or FX conversion |
| Manual override and subsequent edit | Zero remains a valid explicit charge; actor/reason are retained; changed approved subject cannot execute |
| Price update during preview/save | Stale preview/version is rejected or explicitly refreshed with a visible difference |
| Concurrent configuration edit | Stale writer cannot overwrite the saved version |
| Workbook import repeated | Mapping/diff preview prevents duplicate products and unintended price replacement |
| Denied or expired session; revoked grant | Direct API and console writes are refused before mutation |
| Restart after activation or invoice snapshot | One durable version/calculation survives; retries do not reprice historical work |

Use independent expected calculations, application/database boundary tests and a
real authenticated browser journey for edit -> preview -> activate -> draft ->
override -> review. Exercise persisted versions, authorization and concurrency in a
disposable database. Run the required root/web checks, migration probes and parity
checks for schema changes. Unit-only resolver tests do not complete this feature.

## Handoff

Record exact candidate, verification, supported rule types and remaining limits in
the PR. BILL-01 consumes the versioned calculation with DATA-01 shipment allocations;
FLOW-01/UI-01 complete issuance, approval/recovery and bank reconciliation. A pricing
editor or synthetic invoice alone does not complete the receivables milestone.
