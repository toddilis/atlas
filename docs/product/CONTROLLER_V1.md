# Controller v1 — first complete operating responsibility

Atlas is intended to own the supported wholesale receivables journey: eligible Shopify dispatch → one correct invoice per order → owner approval → printable invoice or authorized email → bank-transfer reconciliation or an explicit exception with an owner.

The [owner-confirmed VICE receivables contract](VICE_RECEIVABLES.md) records the actual starting workflow and unresolved inputs. It supersedes earlier generic assumptions of separate shipment invoices and Stripe settlement for this first milestone. See decision D8 in `PLAN.md`.

The initial test environment uses synthetic accounts, NZD and deterministic configured prices/terms. Fixtures are not authorization to use those values in VICE production. Actual billing trigger, terms, taxes, settlement methods, opening balances and accounting handoff must come from authoritative business setup.

## Required behavior

- Onboard Shopify account mapping, workbook pricing/discounts, GoSweetSpot freight charges, terms, currency and tax configuration.
- Store fulfillment lines and original order-line identity; use supported successful fulfillment state and source freshness.
- Preserve order-level invoice identity and shipment quantities. One invoice per order is confirmed; split-dispatch timing and included quantities remain an explicit unresolved decision. Repeated or partial shipments cannot create duplicate invoices or double bill.
- Block missing mappings/SKUs/prices explicitly. Do not silently omit unsupported lines.
- Snapshot terms and authoritative amounts. The approved document, console and aging use the same contract, including the confirmed calendar due-date rule and product exceptions.
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
| Order of 100 units, shipments of 40 then 60 | One invoice identity for the order; timing and included quantities follow the owner-confirmed split-dispatch rule. Until that rule exists, keep the case unresolved rather than creating two invoices |
| Repeat either shipment/event | No extra billed quantity or business effect |
| Missing price then corrected data | Visible exception; supported resume reaches the expected invoice |
| Failed/cancelled fulfillment | No new valid billable shipment; any prior invoice enters the defined correction path |
| Nondefault account terms | Provider/internal due date and statement aging agree |
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

The owner has confirmed Shopify orders, current Excel invoicing/pricing, one invoice per order at dispatch, GoSweetSpot freight, owner approval, print/occasional email, bank transfer and new shipments only. Do not ask for those decisions again. Outstanding inputs are listed in [VICE_RECEIVABLES.md](VICE_RECEIVABLES.md), especially the workbook, split-dispatch rule, terms/tax exceptions and bank/accounting source. Historical opening balances are outside the initial scope. Unknown fields do not block credential-free infrastructure or independent correctness work.
