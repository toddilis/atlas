# VICE receivables: owner-confirmed starting contract

Recorded 25 September 2026 from the owner's answers and subsequent clarification.
Partial fulfillments produce invoice parts such as `#xxxxA`, `#xxxxB`, etc.; this
supersedes the earlier interpretation of one invoice covering all dispatches of an
order. Stripe settlement is not the first VICE route. This document records
requirements; it does not describe
deployed behavior or authorize automatic customer communication.

## Confirmed business facts

| Area | Owner-confirmed requirement |
| --- | --- |
| Orders | Shopify orders are the source. |
| Existing invoice process | The owner currently creates invoices in Excel. |
| Trigger and grouping | Invoice when goods dispatch. A partially fulfilled order is invoiced in parts, for example `#xxxxA`, `#xxxxB`, etc. Each part covers its dispatched quantities and remains linked to the same Shopify order. |
| Pricing | Atlas must offer adaptable product pricing, retailer agreements and discounts that the operator can maintain in the platform. The uploaded Excel list is an initial import/reference, not a fixed pricing policy. |
| Freight | Shipping rates vary through GoSweetSpot. Atlas must distinguish carrier cost from the customer charge and let the operator configure freight rules and invoice-specific exceptions. Existing examples inform initial configuration. |
| Tax practice | The owner reports GST on invoices except Australia and other export destinations. Exact destination/tax configuration and supporting rules remain to be established; this statement alone is not an executable tax rule. |
| Standard terms | Usually the 20th of the following month. Exceptions, including custom designs, are decided case by case; the owner must specify the applicable terms/due date on the invoice before approving it. The standard rule's month anchor still needs confirmation. |
| Delivery | Usually a printed invoice in the shipment; sometimes email. The invoice carries the Shopify order number. |
| Approval | The owner approves invoices initially. Automatic sending is a future capability requiring separately granted authority once outcomes are trusted. |
| Payment | Bank transfer; full payment is the expected supported settlement. Customers use the invoice number, or sometimes the invoice total, as a reference. |
| Banks | Wise and ASB are used. Bank connections, export availability and the official accounting record are not yet confirmed. |
| Coverage | New shipments only. Historical outstanding receivables are outside the initial scope. Exact activation cutoff remains unset. |

## First operator journey

1. Discover an eligible Shopify order and its successful dispatch records.
2. Resolve the retailer's configured product pricing/discounts and shipping rule,
   currency, tax configuration and applicable payment terms.
3. Produce an invoice draft for the dispatched quantities, showing invoice number
   and Shopify order number, charges and due date. Partial orders use separate
   suffixed invoice parts linked to the same order. Record case-specific terms
   explicitly before the owner approves each part.
4. Present the exact draft for owner approval. A material change invalidates the
   previous approval before issuance or delivery.
5. Produce a printable approved invoice for packing. Where email is selected and
   authorized, send the same invoice identity and approved document; retain the
   channel outcome. Generating a print file is not proof it was packed or delivered.
6. Import Wise/ASB bank-payment evidence through the confirmed input method, reconcile
   the full amount to the invoice, and show paid status or an explicit exception.

This is the intended application journey, not authority for the coding agent to
issue invoices, email customers or access live bank data during development.

## Engineering constraints derived from these decisions

- Preserve order, order-line, shipment-line, invoice-part and bank-transaction identities.
  Another eligible partial dispatch can create the next invoice part. A repeated
  event or reprint must reuse its existing invoice identity and never bill the same
  quantities twice. Shopify order number and invoice number remain distinct fields
  until the workbook confirms the source of the `xxxx` base number.
- For an order dispatched 40/60, the two parts bill 40 and 60 respectively, use
  distinct stable suffixes such as A/B, and total the order's eligible quantities.
  Approval, delivery, due date, balance and settlement are tracked per invoice part.
- Import selected workbook data into editable, versioned Atlas price books. Resolve
  configured retailer prices/discounts and shipping charges with a visible explanation;
  snapshot the accepted rules, source inputs and amounts on each invoice. Missing or conflicting
  retailer/SKU mappings, price, freight, currency, tax or terms block approval-ready
  output instead of selecting a guessed value.
- Preserve the standard calendar due-date rule; do not replace it with a fixed
  number of days. Confirm its month anchor. Do not invent a product-wide exception
  rule from "case by case": capture the owner's selected terms/due date on the
  specific invoice and include them in the stored approval subject.
- Match bank transfers using stable transaction identity and available invoice,
  payer, amount and currency evidence. An amount-only reference can identify a
  candidate, but is not sufficient by itself to confirm payment automatically.
  Ambiguous matches require operator resolution; repeated imports cannot post twice.
- Preserve unexpected partial payments, overpayments and unmatched receipts as
  visible exceptions. "Full payment only" does not mean discarding actual bank
  records or marking a short payment as fully paid.
- Customer-specific email selection and invoice approval must not accidentally
  authorize reminders, credits, refunds or write-offs. Their operating rules remain
  outside this first approved scope.
- Existing Stripe integration may remain in the codebase, but is not the assumed
  invoice issuer, payment rail or completion evidence for this VICE pilot.

## Inputs still needed

1. The invoice/pricing workbook has been received and inspected: it supplies a
   populated invoice layout and one SKU price list. It does not encode retailer
   discounts or configurable shipping rules. Confirm which prices to import into
   which initial price book, the intended currency/tax basis and retailer agreements
   when configuring the pilot. These values do not block building the pricing editor.
2. One matching Shopify order/dispatch and completed invoice, with a GoSweetSpot
   shipment/rate example to explain the actual customer freight charge.
3. An example partial-order invoice pair to confirm the base number, suffix format,
   freight allocation and relationship to the Shopify order number.
4. Whether the usual 20th follows the invoice month or dispatch month; export tax
   configuration. Case-specific terms will be entered by the owner per invoice,
   rather than requiring a universal custom-design terms rule.
5. The official accounting record and available Wise/ASB payment input (for example,
   bank CSVs), plus a representative redacted payment record. Bank names alone do
   not establish an available feed, file format, access or connection authority.
6. The activation cutoff and handling of orders already invoiced before that cutoff;
   per-customer print/email preferences and invoice recipient mappings.

## Adaptable pricing requirement

The operator must be able to change product prices, retailer-specific prices or
discounts, effective dates and shipping rules without a code deployment. A preview
must show the chosen price, discount, carrier cost, customer freight charge, tax and
total, with the reason each rule applied. A one-off price or freight override requires
a recorded reason and is part of the invoice approved by the owner.

Price changes apply according to the configured effective date and pricing-date
basis. They must not silently rewrite approved/issued invoices or reprice a retry.
An explicit draft reprice shows the difference and invalidates any prior approval
of changed material terms. No discount stacking, missing-price fallback, freight
allocation or export tax rule is inferred from the workbook.

[PRICING-01](../development/tasks/PRICING-01.md) makes the operator journey and
acceptance cases concrete. Product/shipping policy values remain configuration;
unknown live inputs do not block the platform or synthetic test work.
