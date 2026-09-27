# Atlas Authority & Governance v0.2

## 1. Principle

Atlas autonomy is earned per action class, context and risk---not
granted globally to an agent.

Learning and authority are separate systems.

## 2. Authority ladder

1.  **OBSERVE** --- read and detect only.
2.  **RECOMMEND** --- produce a proposed decision.
3.  **PREPARE** --- prepare the action/draft but do not execute.
4.  **ACT_WITH_APPROVAL** --- execute only after explicit approval.
5.  **ACT_WITHIN_LIMITS** --- execute autonomously inside deterministic
    caps/conditions.
6.  **AUTONOMOUS** --- broad delegated execution for a tightly defined
    action domain.

The same module can have different authority levels for different action
types.

## 3. Risk classes

### Class A --- Low consequence

Reversible, low-value, bounded actions.

### Class B --- Material

Customer, financial, inventory, campaign or operational impact that
warrants stronger controls.

### Class C --- High consequence

Large monetary exposure, legal/compliance implications,
destructive/irreversible actions, broad permissions, or material
reputational risk.

Exact thresholds are company configuration/policy, not hard-coded Atlas
Core.

## 4. Policy evaluation

Before any side effect, deterministic policy should evaluate:

-   actor/module
-   company
-   action type
-   target account/system
-   requested parameters
-   monetary/value exposure
-   reversibility
-   risk class
-   current authority
-   allowlists/denylists
-   caps
-   required approvals
-   expiry
-   conflicts
-   current system state

## 5. Authority changes

Atlas may generate an `AuthorityChangeProposal` based on evidence, but
only an authorised human/governance process can approve the change.

Signals may include: - sustained outcome quality - low reversal/error
rate - stable operating conditions - adequate sample size - successful
recovery history

Approval counts alone are insufficient.

## 6. Execution states

Consequential actions should distinguish at least:

`PROPOSED → PREPARED → AUTHORISED → EXECUTING → CONFIRMED`

Failure paths:

`FAILED`, `UNRESOLVED`, `RECONCILIATION_REQUIRED`, `REVERSED`.

Never equate "API request sent" with "business action confirmed."

## 7. Audit

Every consequential action requires: - initiating observation/decision -
rationale/provenance - policy snapshot - approval where required - exact
tool call intent - execution result - confirmation/reconciliation
evidence - later outcome linkage where measurable

## 8. Recovery

Atlas must be designed for partial failure.

Required patterns: - idempotency - retry policy - reconciliation -
duplicate prevention - unresolved-action queues - operator visibility -
reversible action support where possible

## 9. Governance invariants

-   AI cannot modify its own permissions.
-   Memory cannot override policy.
-   Module code cannot bypass the policy layer.
-   Company configuration cannot silently redefine core security
    invariants.
-   High-impact policy changes are auditable.
-   Unknown execution state is treated as unresolved, not success.

## 10. Binding and current checks

Follow the [approval/execution specification](EXECUTION_AND_APPROVAL_SPEC.md). Approval
is scoped to stored intent and revisions, never a reusable permission token. Recheck
authenticated authority, tool grants, policy, pause/revocation and source preconditions
at execution. Risk classes A/B/C are consequence categories, not the existing runtime
RiskTier values (auto/notify/approve_required), which describe approval handling. Do not
cast between them or infer authority from a risk label.
