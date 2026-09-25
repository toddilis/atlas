# DATA-01 - successful dispatch lines and invoice allocations

Status: next independent coding slice after BUILD-01; not yet implemented. Start from
the current verified repository and inspect active PRs before making a bounded branch.
Use synthetic Shopify fixtures and a disposable database. No real customer dispatch
or invoice issuance is required for this task.

## User outcome

Atlas knows exactly which order lines and quantities each successful dispatch covers.
A 100-unit order dispatched 40 then 60 exposes two distinct eligible allocations,
never two 100-unit allocations. Repeated events preserve the same identities.

## Verified starting gap

The reviewed webhook projector/sync store fulfillment headers and raw data, while
`src/agents/controller/tools/draft_invoice.ts` reads `shopify_order_lines.quantity`
and groups by SKU. The canonical fulfillment table has no normalized dispatch lines.
The existing invoice RPC deduplicates by fulfillment event, which alone does not
prevent billing original order quantities for each partial shipment.

Read the Shopify sync/projector, Controller routing and draft tool, billing RPCs,
event projection/replay contracts and migrations before editing. Preserve existing
canonical IDs and forward-only migration history.

## Scope and boundary

- Follow [the product contract](../../product/PLATFORM_PRODUCT.md). Implement this
  slice's PLAT-01 boundary with explicit business/connection context and an Atlas
  dispatch/order-line contract. Keep Shopify payload interpretation and external IDs
  in its adapter/source mapping; another provider must not require copying Controller.
- Preserve tenant-scoped identity and deduplication when two businesses use identical
  SKUs or source IDs. Never infer authority from an untrusted business ID. Test the
  affected boundaries with two synthetic businesses; this alone does not pass TENANT-01.
- Normalize dispatch-line source identity and its original order-line relationship.
  Preserve fulfillment identity, source status, quantity, revision/time and location.
- Define successful/billable eligibility explicitly. Missing lines, unknown original
  order lines, invalid quantities or unsupported statuses remain visible exceptions.
- Prevent a stale source revision from replacing a newer one. Handle webhook-before-
  order and replay through the existing recoverable projection path.
- Provide a deterministic read/allocation contract consumed by BILL-01. Keep separate
  original order lines even when they share an SKU; they may have different terms.
- Design database-enforced allocation identity and quantity bounds so concurrent or
  repeated claims cannot allocate the same dispatch quantity twice. Invoice-part and
  order identities remain distinct from their configurable display numbers.
- A cancellation/correction after allocation retains original history and surfaces
  a correction case. Do not silently erase an issued invoice or free its allocation
  for duplicate billing. Define transactional ownership with BILL-01.
- Publish records and unresolved states needed by the later operator view and
  inventory work. A dispatch feed alone does not establish opening stock balances.

This slice may add the allocation schema/guard and internal contract, but does not
activate live billing. BILL-01 switches invoice drafting to that contract and proves
the actual A/B invoices. It must not call itself complete while using order quantities.
Pricing, final number format, freight, approval and delivery stay in dedicated tasks.
Unknown numbering does not block stable internal identity.

## Acceptance

| Case | Expected evidence |
| --- | --- |
| 100 ordered, 40 dispatched then 60 | Canonical lines and eligible allocations are 40/60 with original line identity retained |
| Repeat webhook, replay and bulk sync | Same dispatch-line identities and quantities; no duplicate allocation |
| Webhook before original order | Durable visible pending projection; reconciliation links the same source once the order arrives |
| Two order lines share a SKU | Relationships remain distinct; no quantity/pricing agreement collapse |
| Cancelled, failed, missing or malformed dispatch | No approval-ready billable allocation; explicit reason |
| Stale update after a newer update | Canonical current state is not rolled back |
| Concurrent allocation attempts | Database constraints/transaction allow only non-overlapping valid allocations |
| Dispatch corrected after allocation | Original allocation remains auditable and a correction case is created |
| Cross-organization/source mismatch | Reject the relation/claim before persisting a billable allocation |
| Process stops during normalization/allocation | Retry converges without a half-written or duplicated result |

Verify ingestion -> canonical rows -> allocation/eligibility at application and real
database boundaries. Regenerate database types and run root/web checks, migration
probes and SQL/TypeScript parity for schema changes. Include malformed/no-SKU paths,
which must never silently drop a billable line.

## Handoff

Record exact candidate, schema, source examples, executed checks and unresolved source
semantics. BILL-01 consumes eligible quantities atomically with invoice creation;
INV-01 reuses identities after confirming stock source and baseline. No full invoicing,
stock accuracy or deployment claim follows from this data slice.
