# FLOW-01B — the shared bank source and receipt reconciliation

PLAN D18 makes the Wise/ASB import a shared, business-scoped bank source that keeps every
line. The Controller matches customer receipts to invoices from it (this task); the
Bookkeeper module later matches or codes the rest. FLOW-01A (approve, issue, print) and
PAY-01 (manual payment entry, 0043) are merged.

## User outcome

The operator imports a bank statement file for one of the business's bank accounts and
sees every line stored exactly once, with who imported it and when. Customer receipts are
then matched to invoices with stated evidence: a confident match is confirmed by the
operator and records the payment exactly once; ambiguous, partial, excess and unmatched
receipts stay visible as exceptions until resolved. Nothing in a refused file is imported.

## Verified starting gap

- Payments are recorded by hand, one invoice at a time (PAY-01). Nothing holds bank lines,
  so receipt evidence and duplicate detection rest on the operator.
- The Wise/ASB export sample (VICE_RECEIVABLES input 5) has not arrived, so neither bank's
  file layout is confirmed.

## Scope and slices

### FLOW-01B-a — bank accounts and statement import (migration 0051, #62 merged)

- Bank accounts per business: display name, bank, account reference and currency. Bank,
  reference and currency are the account's identity, and there is one account per
  currency balance (a multi-currency Wise account is one account per currency). The name
  and enabled state can change; a disabled account takes no imports.
- One CSV file per import, for one account. Until the sample arrives the only format is
  `atlas_csv_v1`: a header row; `date` (YYYY-MM-DD), a signed `amount` like `-45.20` and
  `description`; optional `reference`, `counterparty`, `transaction_id` and `currency`.
  Wise and ASB layouts become further `import_format` adapters validated against the real
  sample. No layout is guessed.
- Each line is stored once per account: by the bank's transaction id when the file has
  one, otherwise by its content (date, amount, description, reference, counterparty) and
  its order among identical lines in the file. Re-importing a file adds nothing; an
  overlapping export adds only the lines not yet held. The same transaction id with
  different details refuses the whole file.
- The whole file is checked before anything is written; an invalid line refuses it with
  the line number and reason.
- Lines are append-only evidence that retains the parsed source row. Each import records
  the file name, SHA-256, account, counts (new and already held), date range and operator,
  and is audited.
- Grants `bank_accounts.save` and `bank.import` are seeded notify-tier at boot: setup and
  evidence, since an import moves no money and changes no invoice. The database enforces
  pause and the grants.
- Console `/bank`: accounts (add, rename, disable), the import form with the format's
  columns, recent imports and recent lines ("not matched yet"), with explicit empty,
  refused, paused and switched-off states.

### FLOW-01B-b — receipt matching and exceptions (migration 0052)

- Deterministic matching of credit lines to issued invoices, on the invoice number in the
  reference or description and the outstanding amount in the same currency. A matching
  total alone makes a candidate, never a confirmation.
- States: proposed (one invoice, the exact outstanding amount), ambiguous, partial,
  excess and unmatched. Debit lines are outside the Controller's scope and wait for the
  Bookkeeper.
- Confirming a proposal records the payment through `operator_record_payment` (the
  `payments.record` grant, the outstanding cap and exactly-once posting) with the bank
  line as its reference. One bank line settles at most its own amount across invoices.
- The operator resolves exceptions in the console: choose the invoice and amount (one
  payment per line and invoice, so a split is one confirmation per invoice), or mark the
  line as not a receipt with a reason. A marked line can be reopened with a reason.

### FLOW-01B-c — Wise and ASB formats (when the sample arrives)

- An adapter per real layout, tested against the redacted sample, covering sign
  conventions, date formats and Wise's per-currency statements.

## Acceptance (FLOW-01B-a)

- Database probe: a missing or approve_required grant is refused; pause and identity are
  enforced; account fields are validated and the identity fields are fixed; a stale edit
  is refused. A first import stores every line, the batch and the audit row; an exact
  re-import adopts the stored batch; an overlapping import stores only the new lines;
  identical lines in one file are both stored; a conflicting transaction id or a currency
  mismatch writes nothing; a disabled account or another business's account is
  unreachable; lines cannot be updated or deleted; the entry points are service-only.
- Unit tests: CSV parsing (quotes, embedded commas and newlines, CRLF, BOM), strict dates
  and exact-cent amounts, header and column-count errors with line numbers, size and line
  limits, and the outcome map.
- Browser journey: add an account, import a file and see its lines, re-import it (nothing
  new), import an overlapping file (only the new line), and see a refused file's line and
  reason.

## Handoff

Record the PR, candidate commit and checks in the PR and its queue row. FLOW-01B-b
follows; FLOW-01B-c waits for the sample.
