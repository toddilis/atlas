# VICE receivables: owner-confirmed starting contract

Recorded 25 September 2026 from the owner's answers. These decisions supersede
earlier generic assumptions of an invoice per shipment and Stripe settlement for
the first VICE workflow. This document records requirements; it does not describe
deployed behavior or authorize automatic customer communication.

## Confirmed business facts

| Area | Owner-confirmed requirement |
| --- | --- |
| Orders | Shopify orders are the source. |
| Existing invoice process | The owner currently creates invoices in Excel. |
| Trigger and grouping | Invoice when goods dispatch; one invoice per order. Split-dispatch timing is still unresolved. |
| Pricing | The existing Excel workbook contains the price list. Retailers have different pricing and discounts. |
| Freight | Shipping rates vary through GoSweetSpot. How the rate becomes the customer charge needs a worked example. |
| Tax practice | The owner reports GST on invoices except Australia and other export destinations. Exact destination/tax configuration and supporting rules remain to be established; this statement alone is not an executable tax rule. |
| Standard terms | Usually the 20th of the following month. Certain products, including custom designs, have exceptions. The month anchor and exception rules need confirmation. |
| Delivery | Usually a printed invoice in the shipment; sometimes email. The invoice carries the Shopify order number. |
| Approval | The owner approves invoices initially. Automatic sending is a future capability requiring separately granted authority once outcomes are trusted. |
| Payment | Bank transfer; full payment is the expected supported settlement. Customers use the invoice number, or sometimes the invoice total, as a reference. |
| Coverage | New shipments only. Historical outstanding receivables are outside the initial scope. Exact activation cutoff remains unset. |

## First operator journey

1. Discover an eligible Shopify order and its successful dispatch records.
2. Resolve the retailer's workbook pricing/discounts, confirmed freight charge,
   currency, tax configuration and applicable payment terms.
3. Produce one order-level invoice draft showing both invoice number and Shopify
   order number, source quantities, charges and due date.
4. Present the exact draft for owner approval. A material change invalidates the
   previous approval before issuance or delivery.
5. Produce a printable approved invoice for packing. Where email is selected and
   authorized, send the same invoice identity and approved document; retain the
   channel outcome. Generating a print file is not proof it was packed or delivered.
6. Import bank-payment evidence from the source selected by the owner, reconcile
   the full amount to the invoice, and show paid status or an explicit exception.

This is the intended application journey, not authority for the coding agent to
issue invoices, email customers or access live bank data during development.

## Engineering constraints derived from these decisions

- Preserve order, order-line, shipment-line, invoice and bank-transaction identities.
  A repeated event, another dispatch or a reprint must not create another invoice
  for the same order. Shopify order number and invoice number are distinct fields
  until the workbook confirms whether they happen to use the same value.
- Do not reuse the earlier two-invoice 40/60 shipment scenario. Split orders stay
  visibly unresolved until the single-invoice timing and quantity rule is decided.
- Import and snapshot the workbook's accepted pricing rules. Missing or conflicting
  retailer/SKU mappings, price, freight, currency, tax or terms block approval-ready
  output instead of selecting a guessed value.
- Preserve the standard calendar due-date rule; do not replace it with a fixed
  number of days. Define its month anchor and custom-product precedence first.
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

1. The current Excel invoice/pricing workbook, including representative retailer
   pricing and discount rules, invoice layout and numbering. Confirm the intended
   currency and whether workbook prices/charges include or exclude GST.
2. One matching Shopify order/dispatch and completed invoice, with a GoSweetSpot
   shipment/rate example to explain the actual customer freight charge.
3. The single-invoice rule for split dispatches: first dispatch, final dispatch,
   or an operator-held exception. Do not select one silently.
4. Custom-design/product/customer payment-term exceptions; whether the usual 20th
   follows the invoice month or dispatch month; export tax configuration.
5. The official accounting record and available bank-payment input (for example,
   a bank CSV or accounting feed), plus a representative redacted payment record.
6. The activation cutoff and handling of orders already invoiced before that cutoff;
   per-customer print/email preferences and invoice recipient mappings.

Workbook inspection can resolve several fields without another questionnaire.
Unknown fields remain unset. Synthetic infrastructure and bounded correctness work
can continue; live invoicing and dependent business behavior wait for their inputs.
