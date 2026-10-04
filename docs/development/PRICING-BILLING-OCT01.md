# Pricing and Controller billing: 1–7 October 2026

Branch `codex/pricing-billing-oct01`, isolated clone under the matching Codex task.
Starting commit `cbcb2e7620e73f1406bc8e31edb5b91687c866fb` includes DATA-01 and
architecture v0.2. The earlier `claude/pr-d-pricing-drafts` work is already merged;
its legacy resolver remains available and the versioned path extends that module.

## Reviewable slices and gates

1. Versioned deterministic pricing + immutable configuration storage: implemented
   for synthetic previews; persistence/database acceptance is pending.
2. Protected operator edit/preview/activate: waits for AUTH-01 browser acceptance
   and the AUTHZ-02 tool seam. No unprotected console write is added.
3. BILL-01 SQL transaction: implemented pending real database verification. Claims
   DATA-01 lines, creates stable suffixed parts, validates totals, stores immutable
   calculation/document content, publishes through EVENT-01 in the same transaction.
4. Approved printable output/status: pure stored-content renderer prepared; runtime
   tool/console integration waits for AUTH and EVENT/EVIDENCE acceptance.

Migrations: 0023 pricing; 0028 billing (coordinator moved billing after shared
0025–0027 dependencies; 0024 remains vacant). Shared queue, PLAN and issue_invoice.ts
are owned by other tracks. No live invoice, email, bank connection or deployment.

## Supported calculation contract

Business-wide immutable bundles contain exact product mappings, retailer bindings,
negotiated prices, quantity tiers, percentage/fixed discounts, explicit precedence
and stacking policy, currency/scale, exclusive tax, timezone, pricing date basis and
effective interval. Activations advance the effective timeline; the newest activated
start on/before the pricing instant supersedes preceding versions. End boundaries
are exclusive; an expired selected version cannot fall back to an older one.

Shipping can be disabled. Supported modes: actual cost, fixed/percentage markup,
fixed, free and reasoned manual charge. Carrier identity/cost remains separate from
customer charge. Per-dispatch charge or explicit whole-order allocation schedule is
required; schedules freeze on the first invoice and cannot change on later parts.
Unknown or conflicting rules fail visibly. Only exact integer units and scale-2,
tax-exclusive configurations are supported in this slice. Service businesses can
preview pricing without Shopify, stock or shipping; non-dispatch billing is not yet
implemented. Whole-order threshold values require a trusted calculated input.

Snapshots contain input/source identities, config version, ordered/dispatched
quantities, rule explanation, override actor/reason, freight evidence/schedule,
tax and terms/due date. Monetary values are decimal strings; bigint calculations
floor each percentage reduction and invoice tax. A snapshot is a copied value;
configuration changes do not mutate it. Explicit repricing/revision UI is pending.

Trusted `org_id` maps to shared `company_id`; caller IDs are not authority. The
additive `controller.invoice.drafted` v1 reader names the Invoice and calculation/
document references with equal business/revision and exact MoneyV1. It is distinct
from the legacy versionless event. Reader-first rollout is required before writers.

BILL requires `publish_platform_event` from EVENT-01. Missing publication fails the
whole claim/invoice transaction; no alternative outbox is introduced. Document
generation means only generated, never printed, packed, emailed or delivered.

## Evidence so far

Root typecheck and nine focused pricing tests passed with Node 20.20.2, `--jitless`,
bounded 1 GB heap (30 September UTC / 1 October NZ). Earlier host memory failures
are environment failures, not passed tests. Synthetic 100-unit 40/60 previews use
800 minor-unit tier price, freight 400/600, tax 4,860/7,290, totals 37,260/55,890;
due date 20 November. Tests cover both retailers, effective boundaries, immutable
copies, service configuration, freight modes/evidence/thresholds, conflicts and
amounts above JavaScript safe-integer precision. Database, browser, full CI and
independent review remain pending and must be attached to the actual candidate.

Real commercial values, numbering policy, terms anchor, carrier examples and pilot
cutoff remain onboarding gates. Synthetic values do not establish VICE policy.
Bank reconciliation is stretch after the core journey.

## 4 October checkpoint

Draft [PR #28](https://github.com/toddilis/atlas/pull/28) preserves the first candidate
`6d54900c618de9f69e80d7eea184ba3bd4372dda`. Independent reviewer F7 found that the
SQL accepted internally consistent but unconfigured prices. `e103666` added independent
SQL rule/price/freight/terms verification and source-time checks; its first SQL run
caught JSONB operator precedence in the new terms check. Replacement
`3f5123db711f8fe00d3418b97109c0ad345e82a0` fixes that and adds trusted internal adapters.
[CI 37187061736](https://github.com/toddilis/atlas/actions/runs/37187061736) passed
root and console tests/builds, migrations including the forged-money/terms/date probes,
and DATA concurrency. Only generated-type drift failed; parity was consequently skipped.
Types are copied from that run's disposable database artifact in the next candidate.

The preserved September `atlas-pricing` checkout was compared read-only. Its editor
flow and regression scenarios are reused, while this branch retains one configuration
store/calculator. New regression cases cover effective version supersession, import
retry, negotiated prediscount thresholds, increased overrides, zero freight allocation
and escaped immutable print content. The staged PricingEditor component has no route
or server callback wired until AUTH-01 acceptance.

Persisted manual price/freight overrides and whole-order thresholds currently refuse
with explicit dependency errors; they need a protected exception/whole-order calculation
source. Their pure previews are implemented, not a claim of persisted workflow support.
Canonical dispatch time is required; order-date persisted billing presently verifies
Shopify placed_at. Other source adapters use dispatch-date pricing until they provide
authoritative order time. Arbitrary carrier evidence/terms are still proposed inputs;
live evidence adapters and operator-authorized exception attribution remain gates.

The standalone SQL suite tests rollback when EVENT is absent and explicitly reports
the successful BILL journey blocked. The coordinator authorized a separate integration
rehearsal using EVENT `07e578f07d0aaa58d6a339fe607764862bc8f143` and AUTH
`2179d8c8f4bb6662a68a0f8d9dc78e78725f1a99`; neither that rehearsal nor this draft is
acceptance of AUTH's pending browser tests, provider operation or deployment.
