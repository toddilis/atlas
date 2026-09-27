# Controller v1 — first complete operating responsibility

Atlas is intended to own the supported wholesale receivables journey: eligible Shopify dispatch → correct invoice or partial-order invoice part → owner approval → printable invoice or authorized email → Wise/ASB bank-transfer reconciliation or an explicit exception with an owner.

The [owner-confirmed VICE receivables contract](VICE_RECEIVABLES.md) records the actual starting workflow and unresolved inputs. Partial orders produce suffixed invoice parts, such as `#xxxxA` and `#xxxxB`. Stripe settlement is not the assumed pilot route. See decisions D8, D9 and D10 in `PLAN.md`; D9 corrects invoice grouping, and D10 requires adaptable pricing within Atlas.

The initial test environment uses synthetic accounts, NZD and deterministic configured prices/terms. Fixtures are not authorization to use those values in VICE production. Actual billing trigger, terms, taxes, settlement methods, opening balances and accounting handoff must come from authoritative business setup.

## Required behavior

- Onboard Shopify account mapping, initial price data, GoSweetSpot cost evidence, terms, currency and tax configuration.
- Let the operator maintain product price books, retailer prices/discounts, effective dates and shipping rules in Atlas. Preview the selected rules and calculated charges before use; the workbook is an import/layout reference.
- Distinguish carrier cost from customer freight charge. Store the chosen shipping policy and allocation across invoice parts; missing inputs and conflicting rules are visible exceptions.
- Store reasoned price/freight overrides in the approved invoice. Preserve prior invoice snapshots when pricing configuration changes; explicit repricing of an invoice invalidates its old approval when material terms change.
- Store fulfillment lines and original order-line identity; use supported successful fulfillment state and source freshness.
- Preserve order-level grouping, distinct invoice-part identities and shipment allocations. Partial dispatches produce suffixed invoices for their dispatched quantities; repeated events and reprints cannot create duplicate parts or double bill.
- Block missing mappings/SKUs/prices explicitly. Do not silently omit unsupported lines.
- Snapshot terms and authoritative amounts. The approved document, console and aging use the same contract, including the standard calendar rule or owner-selected terms for that specific invoice. Cases such as custom designs require explicit terms before approval.
- Enforce agent/operator entitlement and business policy; bind approval to stored parameters and material state.
- Persist each continuation. Recover missing data, worker crashes and uncertain provider results without manual endpoint calls.
- Produce an owner-approved printable invoice carrying the Shopify order number. Distinguish generated/printed, packed, email-requested and confirmed/failed delivery where supported; a generated document is not proof of customer receipt.
- Reconcile full bank transfers using imported payment identities and sufficient matching evidence. Amount-only or ambiguous matches and unexpected partial payments remain visible exceptions; repeated imports cannot create duplicate credit.
- Handle supported credits/voids/disputes/refunds or route them to a named operator-owned case.
- Produce correct statements/overdue work and reconcile with the named accounting system of record.
- Show the user completed, pending, blocked, failed and stale states, including the next useful action.

## Required scenarios

| Scenario | Expected result |
| --- | --- |
| Order of 100 units, shipments of 40 then 60 | Two invoice parts, such as `#xxxxA` for 40 and `#xxxxB` for 60, linked to the same order; no overlapping allocation or duplicate billing |
| Repeat either shipment/event | No extra billed quantity or business effect |
| Missing price then corrected data | Visible exception; supported resume reaches the expected invoice |
| Operator changes retailer pricing or shipping policy | Authenticated editor validates and previews the new version without a deployment; eligible new drafts use it and prior invoice snapshots remain unchanged |
| Two retailers buy the same SKU | Their configured agreements determine the price; the preview explains any discount and prevents unintended stacking |
| Carrier cost differs from customer shipping charge | Both amounts and the applied rule remain visible; free shipping is an explicit charge policy, not a missing cost |
| Price/freight overridden on an invoice | Reason and actor are recorded; changed material terms require fresh owner approval |
| Rules conflict or an actual-cost shipping input is missing | Draft is visibly incomplete; no guessed price, zero freight or arbitrary rule selection |
| Failed/cancelled fulfillment | No new valid billable shipment; any prior invoice enters the defined correction path |
| Case-specific terms, including custom designs | Owner specifies terms/due date before approval; the invoice, internal record and statement aging agree |
| Standard 20th-of-following-month terms | Correct calendar due date under the confirmed month anchor; no substitution with net-20 or net-30 |
| Print and email the same approved invoice | Same invoice identity and approved content; Shopify order number appears on both; delivery evidence is channel-specific |
| Changed amount after approval | Stale authorization cannot execute the substituted action |
| Worker crash around each durable handoff | Work is discoverable and resumes or enters an owned exception |
| Provider succeeds but local request times out | Reconcile the existing object before retrying creation |
| Bank transaction import repeats | Receivable/ledger converge without duplicate credit |
| Two invoices share a total; payment has no reliable invoice reference | Visible matching exception; no automatic allocation based solely on equal amount |
| Source sync stops | Dashboard indicates stale coverage and blocks dependent unsafe decisions |

Every user-facing milestone includes the corresponding console behavior and persisted outcome. Unit tests alone do not prove the whole journey. Controlled provider test-mode checks verify external contracts; production validation uses only the separately declared live scope.

## Business setup still needed

The owner has confirmed Shopify orders, adaptable product/shipping pricing in Atlas, suffixed invoice parts for partial dispatches, GoSweetSpot freight, case-specific terms exceptions, owner approval, print/occasional email, Wise/ASB bank transfer and new shipments only. The invoice/pricing workbook has been received. Do not ask for those inputs again. Outstanding pilot configuration is listed in [VICE_RECEIVABLES.md](VICE_RECEIVABLES.md), including initial retailer rules, numbering/freight examples, standard terms anchor, tax configuration and bank-input/accounting details. Historical opening balances are outside the initial scope. Unknown business values do not block the pricing editor or synthetic correctness work.
