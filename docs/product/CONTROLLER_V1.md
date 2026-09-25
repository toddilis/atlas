# Controller v1 — first complete operating responsibility

Atlas is intended to own the supported wholesale receivables journey: eligible successful fulfillment → correct invoice proposal → required authority → confirmed external issuance/delivery status → supported settlement → reconciled records or an explicit exception with an owner.

The initial test environment uses synthetic accounts, NZD and deterministic configured prices/terms. Fixtures are not authorization to use those values in VICE production. Actual billing trigger, terms, taxes, settlement methods, opening balances and accounting handoff must come from authoritative business setup.

## Required behavior

- Onboard account mapping, provider identity, price book, terms, currency and tax configuration.
- Store fulfillment lines and original order-line identity; use supported successful fulfillment state and source freshness.
- Bill fulfilled/unbilled quantities. Preserve corrections and allocation history; repeated or partial shipments cannot double bill.
- Block missing mappings/SKUs/prices explicitly. Do not silently omit unsupported lines.
- Snapshot terms and authoritative amounts. The provider, console and aging use the same contract.
- Enforce agent/operator entitlement and business policy; bind approval to stored parameters and material state.
- Persist each continuation. Recover missing data, worker crashes and uncertain provider results without manual endpoint calls.
- Distinguish locally issued, provider-created/finalized, send-requested and confirmed/failed delivery where supported.
- Reconcile supported payment identities/allocations without repeatedly treating a cumulative total as new money.
- Handle supported credits/voids/disputes/refunds or route them to a named operator-owned case.
- Produce correct statements/overdue work and reconcile with the named accounting system of record.
- Show the user completed, pending, blocked, failed and stale states, including the next useful action.

## Required scenarios

| Scenario | Expected result |
| --- | --- |
| Order of 100 units, shipments of 40 then 60 | Each shipment bills its own quantity; total allocation equals 100 |
| Repeat either shipment/event | No extra billed quantity or business effect |
| Missing price then corrected data | Visible exception; supported resume reaches the expected invoice |
| Failed/cancelled fulfillment | No new valid billable shipment; any prior invoice enters the defined correction path |
| Nondefault account terms | Provider/internal due date and statement aging agree |
| Changed amount after approval | Stale authorization cannot execute the substituted action |
| Worker crash around each durable handoff | Work is discoverable and resumes or enters an owned exception |
| Provider succeeds but local request times out | Reconcile the existing object before retrying creation |
| Payment notification repeats | Receivable/ledger converge without duplicate credit |
| Source sync stops | Dashboard indicates stale coverage and blocks dependent unsafe decisions |

Every user-facing milestone includes the corresponding console behavior and persisted outcome. Unit tests alone do not prove the whole journey. Controlled provider test-mode checks verify external contracts; production validation uses only the separately declared live scope.

## Business setup still needed

Record VICE's actual invoice and settlement route; accounting system of record; invoice trigger; account terms/charges/tax treatment; migration/opening-balance cutoff; supported corrections and payment channels; delegated action limits; and source connections. Keep these as named unset configuration fields until known. They do not block credential-free environment work, entitlement repairs, authentication review or synthetic billing cases.
