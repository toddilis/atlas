/** Architecture foundation reference contracts. Not yet wired into runtime entry points. */
import { createHash } from 'node:crypto';
import { z } from 'zod';

const id = z.string().min(1);
const timestamp = z.string().datetime({ offset: true });
const revision = z.number().int().positive().safe();
const ref = z.object({ company_id: id, type: id, id, revision: revision.optional() }).strict();
const refs = z.array(ref);
const base = { contract_version: z.literal(1), company_id: id, created_at: timestamp };
const risk = z.enum(['A', 'B', 'C']);
export const MoneyV1 = z.object({
  amount_minor: z.string().regex(/^(0|[1-9][0-9]*)$/),
  currency: z.string().regex(/^[A-Z]{3}$/),
  scale: z.number().int().min(0).max(6),
}).strict();

export const ObservationV1 = z.object({
  ...base, observation_id: id, subject: ref, source: id,
  connection_id: id.nullable(), occurred_at: timestamp, observed_at: timestamp,
  evidence_refs: refs.min(1), quality: z.enum(['verified', 'unverified', 'stale', 'conflicting']),
}).strict();

export const DecisionV1 = z.object({
  ...base, decision_id: id, revision, decision_type: z.literal('controller.invoice_delivery'),
  subject_refs: refs.min(1), trigger_refs: refs.min(1), state_snapshot_ref: ref,
  options_considered: z.array(id).min(1), recommended_option: id,
  expected_outcomes: z.array(id).min(1), rationale: id,
  assumptions: z.array(id), uncertainties: z.array(id), risk_class: risk,
  policy_refs: refs.min(1), model_or_rule_provenance: id, expires_at: timestamp,
}).strict().superRefine((value, ctx) => {
  if (!value.options_considered.includes(value.recommended_option))
    ctx.addIssue({ code: 'custom', message: 'Recommendation must be a considered option' });
  if (Date.parse(value.expires_at) <= Date.parse(value.created_at))
    ctx.addIssue({ code: 'custom', message: 'Decision expiry must follow creation' });
});

export const InvoiceDeliveryParametersV1 = z.object({
  invoice_id: id, invoice_revision: revision, document_snapshot_ref: ref,
  total: MoneyV1, channel: z.enum(['print', 'email']), recipient: z.string().email().nullable(),
}).strict().superRefine((value, ctx) => {
  if ((value.channel === 'email') !== (value.recipient !== null))
    ctx.addIssue({ code: 'custom', message: 'Only email delivery requires a recipient' });
});

export const ActionStateV1 = z.enum([
  'PROPOSED', 'PREPARED', 'AUTHORISED', 'EXECUTING', 'CONFIRMED',
  'FAILED', 'UNRESOLVED', 'RECONCILIATION_REQUIRED', 'REVERSED',
]);
export const ActionV1 = z.object({
  ...base, action_id: id, revision, decision_id: id, decision_revision: revision,
  action_type: z.literal('controller.invoice.deliver'), tool: id, subject: ref,
  target: z.object({ account_id: id, connection_id: id.nullable() }).strict(),
  parameters: InvoiceDeliveryParametersV1, risk_class: risk,
  required_authority: z.literal('ACT_WITH_APPROVAL'), idempotency_key: id,
  policy_snapshot_ref: ref, execution_state: ActionStateV1,
  prepared_at: timestamp, authorised_at: timestamp.nullable(),
}).strict().superRefine((value, ctx) => {
  if (value.parameters.channel === 'email' && value.target.connection_id === null)
    ctx.addIssue({ code: 'custom', message: 'Email action requires a connection' });
  if (value.subject.type !== 'Invoice' || value.subject.id !== value.parameters.invoice_id ||
      value.subject.revision !== value.parameters.invoice_revision)
    ctx.addIssue({ code: 'custom', message: 'Invoice parameters must match the versioned subject' });
  if (!['PROPOSED', 'PREPARED'].includes(value.execution_state) && value.authorised_at === null)
    ctx.addIssue({ code: 'custom', message: 'Execution states require an authorization timestamp' });
});
export type ActionV1 = z.infer<typeof ActionV1>;

// Stable JSON for this schema's JSON-only intent. Version this algorithm with the contract.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.entries(value)
    .sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    .map(([key, child]) => `${JSON.stringify(key)}:${canonical(child)}`).join(',')}}`;
  return JSON.stringify(value);
}

/** Binds immutable action intent; execution progress does not change the approved intent. */
export function actionIntentHash(input: ActionV1): string {
  const { created_at, prepared_at, authorised_at, execution_state, ...intent } = ActionV1.parse(input);
  return createHash('sha256').update(canonical(intent)).digest('hex');
}

export const ApprovalV1 = z.object({
  ...base, approval_id: id, decision_id: id, decision_revision: revision,
  action_id: id, action_revision: revision, action_intent_hash: z.string().regex(/^[a-f0-9]{64}$/),
  requested_authority: z.literal('ACT_WITH_APPROVAL'), approver_id: id,
  disposition: z.enum(['approved', 'rejected', 'edited']), reason: z.string().nullable(),
  operator_edits_ref: ref.nullable(), policy_snapshot_ref: ref,
  decided_at: timestamp, expires_at: timestamp, revoked_at: timestamp.nullable(),
}).strict().superRefine((value, ctx) => {
  if (Date.parse(value.expires_at) <= Date.parse(value.decided_at))
    ctx.addIssue({ code: 'custom', message: 'Approval expiry must follow decision' });
  if (value.disposition === 'edited' && value.operator_edits_ref === null)
    ctx.addIssue({ code: 'custom', message: 'Edited decision requires edit evidence' });
});

export const ExecutionV1 = z.object({
  ...base, execution_id: id, action_id: id, action_revision: revision,
  attempt_number: revision, idempotency_key: id, connection_id: id.nullable(),
  state: z.enum(['EXECUTING', 'CONFIRMED', 'FAILED', 'UNRESOLVED', 'RECONCILIATION_REQUIRED']),
  started_at: timestamp, finished_at: timestamp.nullable(), provider_reference: id.nullable(),
  result: z.enum(['document_generated', 'provider_accepted', 'delivery_confirmed', 'no_effect', 'unknown']),
  evidence_refs: refs, error_code: id.nullable(), reconciliation_owner: id.nullable(),
}).strict().superRefine((value, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (value.finished_at !== null && Date.parse(value.finished_at) < Date.parse(value.started_at))
    issue('Attempt finish cannot precede its start');
  if (value.state === 'CONFIRMED' && (value.evidence_refs.length === 0 ||
      !['document_generated', 'delivery_confirmed'].includes(value.result)))
    issue('Confirmation requires evidence of the declared effect; acceptance is not delivery');
  if (['UNRESOLVED', 'RECONCILIATION_REQUIRED'].includes(value.state) && !value.reconciliation_owner)
    issue('Uncertain execution requires a reconciliation owner');
  if (value.state === 'FAILED' && (value.result !== 'no_effect' || !value.error_code))
    issue('Failed attempt requires a known no-effect failure; unknown effects require reconciliation');
  if (['CONFIRMED', 'FAILED'].includes(value.state) && value.finished_at === null)
    issue('Terminal attempt requires a finish timestamp');
});

const metric = z.object({ name: id, value: z.string().regex(/^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/), unit: id }).strict();
export const OutcomeV1 = z.object({
  ...base, outcome_id: id, decision_id: id, action_ids: z.array(id).min(1),
  measurement_window: z.object({ start: timestamp, end: timestamp }).strict(),
  status: z.enum(['known', 'unknown']), metrics_before: z.array(metric), metrics_after: z.array(metric),
  expected_outcomes: z.array(id).min(1), observed_outcomes: z.array(id),
  confounders: z.array(id), evaluation: z.enum(['improved', 'worsened', 'unchanged', 'inconclusive', 'unavailable']),
  evidence_refs: refs, measured_at: timestamp.nullable(), unknown_reason: id.nullable(),
}).strict().superRefine((value, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  if (Date.parse(value.measurement_window.end) <= Date.parse(value.measurement_window.start)) issue('Invalid outcome window');
  if (value.status === 'unknown' && (!value.unknown_reason || value.evaluation !== 'unavailable' ||
      value.metrics_after.length || value.observed_outcomes.length || value.measured_at !== null))
    issue('Unknown outcome must remain explicitly unmeasured');
  if (value.status === 'known' && (!value.measured_at || !value.evidence_refs.length ||
      !value.observed_outcomes.length || value.unknown_reason !== null || value.evaluation === 'unavailable'))
    issue('Known outcome requires measured evidence');
});

export const EventEnvelopeV1 = z.object({
  event_id: id, event_type: id, event_version: z.literal(1), company_id: id,
  connection_id: id.nullable(), occurred_at: timestamp, observed_at: timestamp,
  producer: id, subject_type: id, subject_id: id, subject_version: revision,
  correlation_id: id, causation_id: id.nullable(), source_refs: refs, evidence_refs: refs,
  event_class: z.enum(['fact', 'detection', 'proposal']),
  payload: z.record(z.unknown()),
}).strict();

/** Registry validates payloads as well as the envelope; unknown event types fail closed. */
export const controllerEventPayloads = {
  'controller.decision.proposed': DecisionV1,
  'controller.action.prepared': ActionV1,
  'controller.action.execution_recorded': ExecutionV1,
  'controller.outcome.recorded': OutcomeV1,
} as const;
export const ControllerEventV1 = EventEnvelopeV1.superRefine((event, ctx) => {
  if (!Object.hasOwn(controllerEventPayloads, event.event_type)) {
    ctx.addIssue({ code: 'custom', message: 'Unregistered Controller event' }); return;
  }
  const schema = controllerEventPayloads[event.event_type as keyof typeof controllerEventPayloads];
  if (!schema.safeParse(event.payload).success) ctx.addIssue({ code: 'custom', message: 'Invalid event payload' });
  if (event.payload.company_id !== event.company_id) ctx.addIssue({ code: 'custom', message: 'Event tenant mismatch' });
  function checkTenant(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(checkTenant); return; }
    if (value !== null && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      if ('company_id' in object && object.company_id !== event.company_id)
        ctx.addIssue({ code: 'custom', message: 'Cross-company event reference' });
      Object.values(object).forEach(checkTenant);
    }
  }
  checkTenant(event);
  const subjects: Record<string, [string, string, string | null]> = {
    'controller.decision.proposed': ['Decision', 'decision_id', 'revision'],
    'controller.action.prepared': ['Action', 'action_id', 'revision'],
    'controller.action.execution_recorded': ['Execution', 'execution_id', null],
    'controller.outcome.recorded': ['Outcome', 'outcome_id', null],
  };
  const [type, key, versionKey] = subjects[event.event_type]!;
  if (event.subject_type !== type || event.subject_id !== event.payload[key] ||
      event.subject_version !== (versionKey ? event.payload[versionKey] : 1))
    ctx.addIssue({ code: 'custom', message: 'Event subject does not match payload' });
  if (event.event_type === 'controller.action.prepared' && event.payload.execution_state !== 'PREPARED')
    ctx.addIssue({ code: 'custom', message: 'Prepared event requires a prepared action snapshot' });
  const expectedClass = event.event_type === 'controller.decision.proposed' ? 'proposal' : 'fact';
  if (event.event_class !== expectedClass) ctx.addIssue({ code: 'custom', message: 'Incorrect fact/proposal classification' });
});

export const ACTION_TRANSITIONS: Record<z.infer<typeof ActionStateV1>, readonly z.infer<typeof ActionStateV1>[]> = {
  PROPOSED: ['PREPARED'], PREPARED: ['AUTHORISED'], AUTHORISED: ['EXECUTING'],
  EXECUTING: ['CONFIRMED', 'FAILED', 'UNRESOLVED', 'RECONCILIATION_REQUIRED'],
  UNRESOLVED: ['RECONCILIATION_REQUIRED'], RECONCILIATION_REQUIRED: ['CONFIRMED', 'FAILED'],
  FAILED: ['AUTHORISED'], CONFIRMED: ['REVERSED'], REVERSED: [],
};
export const ActionTransitionV1 = z.object({ from: ActionStateV1, to: ActionStateV1 }).strict()
  .refine(({ from, to }) => ACTION_TRANSITIONS[from].includes(to), 'Invalid action transition');

/** Structural linkage check for a prepared-or-later Controller slice, not runtime authorization. */
export const ControllerChainV1 = z.object({
  observation: ObservationV1, decision: DecisionV1, approval: ApprovalV1,
  action: ActionV1, executions: z.array(ExecutionV1), outcome: OutcomeV1.nullable(),
}).strict().superRefine((chain, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: 'custom', message });
  const { action, approval, decision, observation, executions, outcome } = chain;
  // Child refinements may be dirty (not aborted). Do not throw from safeParse by
  // reparsing invalid intent inside the hash helper; retain the child's issues.
  if (!ActionV1.safeParse(action).success) return;
  const company = action.company_id;
  function checkRefs(value: unknown): void {
    if (Array.isArray(value)) { value.forEach(checkRefs); return; }
    if (value !== null && typeof value === 'object') {
      const object = value as Record<string, unknown>;
      if ('company_id' in object && object.company_id !== company) issue('Cross-company reference');
      Object.values(object).forEach(checkRefs);
    }
  }
  checkRefs(chain);
  if (!decision.trigger_refs.some(r => r.id === observation.observation_id && r.type === 'Observation')) issue('Missing trigger linkage');
  if (!decision.subject_refs.some(r => canonical(r) === canonical(action.subject))) issue('Action subject missing from decision');
  if (action.decision_id !== decision.decision_id || action.decision_revision !== decision.revision) issue('Stale action decision');
  if (approval.decision_id !== decision.decision_id || approval.decision_revision !== decision.revision ||
      approval.action_id !== action.action_id || approval.action_revision !== action.revision ||
      approval.action_intent_hash !== actionIntentHash(action)) issue('Approval does not bind exact intent');
  if (canonical(approval.policy_snapshot_ref) !== canonical(action.policy_snapshot_ref)) issue('Policy snapshot mismatch');
  if (action.authorised_at !== null) {
    const at = Date.parse(action.authorised_at);
    if (approval.disposition !== 'approved' || at < Date.parse(approval.decided_at) ||
        at >= Date.parse(approval.expires_at) || at >= Date.parse(decision.expires_at) ||
        (approval.revoked_at !== null && at >= Date.parse(approval.revoked_at))) issue('Invalid authorization at recorded time');
  }
  const seen = new Set<string>();
  const numbers = new Set<number>();
  for (const execution of executions) {
    if (seen.has(execution.execution_id) || numbers.has(execution.attempt_number)) issue('Duplicate execution attempt');
    seen.add(execution.execution_id); numbers.add(execution.attempt_number);
    if (execution.action_id !== action.action_id || execution.action_revision !== action.revision ||
        execution.idempotency_key !== action.idempotency_key || execution.connection_id !== action.target.connection_id)
      issue('Execution identity mismatch');
    if (action.authorised_at === null || Date.parse(execution.started_at) < Date.parse(action.authorised_at)) issue('Execution precedes authorization');
    if (execution.state === 'CONFIRMED' && execution.result !==
        (action.parameters.channel === 'print' ? 'document_generated' : 'delivery_confirmed')) issue('Wrong confirmation for channel');
  }
  if (action.execution_state === 'CONFIRMED' && !executions.some(e => e.state === 'CONFIRMED')) issue('No confirmed attempt');
  if (outcome && (outcome.decision_id !== decision.decision_id ||
      outcome.action_ids.some(id => id !== action.action_id))) issue('Outcome linkage mismatch');
});
