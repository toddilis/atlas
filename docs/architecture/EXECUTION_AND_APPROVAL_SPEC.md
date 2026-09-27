# Approval, action and execution

## Exact authorization

Approval names company, decision/revision, action/revision, immutable intent fingerprint,
policy snapshot, authenticated approver, disposition, decision time, expiry and revocation.
An edited disposition records preference and a new proposal; it is not execution permission.
Changing the subject, invoice content, price, currency, terms, destination, channel,
connection or other material intent creates a new action revision and needs fresh approval.
The document snapshot captures approved terms and line details without reconstructing them
from current prices. Formatting changes may reuse approval only if the approved content
and intent are unchanged and the rendering contract explicitly permits it.

At execution, load stored intent and verify business membership/job authority, tool grant,
current policy, module/pause status, expiry/revocation, subject version, source freshness
and provider capability. Fail closed on missing inputs. A current stricter policy blocks
the old approval; a looser policy does not broaden its approved parameters. A changed
authorization requirement requires a new approval snapshot. Re-evaluation that still
satisfies the same approval must record the current policy version and result.

## Logical action and attempts

An Action is one intended business effect. Execution is an attempt against its exact
revision, with its own ID/attempt number, timestamps, connection, stable effect-level
idempotency key, provider reference, result evidence and reconciliation owner.
Persist action and durable continuation transactionally before contacting a provider.
Use concurrency control/leases; an expired lease alone never establishes no external effect.

| From | Permitted next state | Required evidence/guard |
| --- | --- | --- |
| PROPOSED | PREPARED | Stored validated intent |
| PREPARED | AUTHORISED | Exact approval and current checks |
| AUTHORISED | EXECUTING | Atomically claimed durable attempt |
| EXECUTING | CONFIRMED | Evidence of the declared effect |
| EXECUTING | FAILED | Known no-effect result |
| EXECUTING | UNRESOLVED / RECONCILIATION_REQUIRED | Unknown result; named owner |
| UNRESOLVED | RECONCILIATION_REQUIRED | Durable reconciliation work |
| RECONCILIATION_REQUIRED | CONFIRMED / FAILED | Provider/state lookup resolves existing effect |
| FAILED | AUTHORISED | Known no effect; same intent and still-valid authorization rechecked |
| CONFIRMED | REVERSED | Separately authorized compensating action confirmed |

The transition validator checks the graph only; runtime guards/evidence remain mandatory.
This slice models execution failures after authorization. Validation/policy refusal is
a blocked proposal/queue reason, not an execution attempt. Revisions preserve earlier
records and do not mutate an already approved intent. Never transition an uncertain
action straight back to execution. Use bounded retries only after no-effect evidence,
reusing the effect's idempotency key. Expired/revoked approvals need fresh authorization.
If a provider cannot prove absence or support safe idempotency, keep an owned exception.

## Confirmation means a specific result

A print action confirms document generation, not printing, packing or customer receipt.
An email action confirms the adapter's declared delivery evidence; provider acceptance
alone remains unresolved. An adapter lacking delivery confirmation cannot claim delivery.
Invoice creation, customer receipt and cash collection are distinct effects/outcomes.
Persist each attempt and confirmation source; never infer delivery from approval consumption.

Legacy `consumeApproval` marks execution before invoking the provider and describes a
fresh decision for every retry. AUTHZ-02/FLOW-01 must migrate this to intent-bound durable
attempt handling. Do not reinterpret old consumed rows as confirmed execution or retrofit
missing proof. Reconcile outstanding legacy actions before enabling the new writer.
