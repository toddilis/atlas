import { z } from 'zod';
import { EventEnvelopeV1 } from '../contracts/controller-v1.js';
import { StoredActionIntent } from '../control-plane/bound-actions.js';

const uuid = z.string().uuid();
// PostgreSQL JSON timestamps use offsets/variable precision. Parse as dates, retain text.
const timestamp = z.string().refine(v => Number.isFinite(Date.parse(v)), 'invalid timestamp');
const actionStates = z.enum(['PREPARED', 'AUTHORISED', 'EXECUTING', 'CONFIRMED', 'FAILED', 'UNRESOLVED', 'RECONCILIATION_REQUIRED']);
const NativeAction = z.object({ id: uuid, org_id: uuid, approval_id: uuid, revision: z.literal(1),
  intent: StoredActionIntent, intent_hash: z.string().regex(/^[a-f0-9]{64}$/), idempotency_key: z.string().min(1),
  state: actionStates, revoked_at: timestamp.nullable(), created_at: timestamp, updated_at: timestamp }).strict();
const NativeAttempt = z.object({ id: uuid, org_id: uuid, action_id: uuid, attempt_number: z.number().int().positive(),
  state: z.enum(['EXECUTING', 'CONFIRMED', 'FAILED', 'UNRESOLVED', 'RECONCILIATION_REQUIRED']),
  started_at: timestamp, finished_at: timestamp.nullable(), result: z.unknown(), evidence: z.unknown(), error: z.string().nullable(), actor_id: z.string() }).strict();
const NativeApproval = z.object({ id: uuid, org_id: uuid, agent_name: z.string(), action: z.string(), subject_type: z.string(), subject_id: uuid.nullable(),
  payload: StoredActionIntent, proposed_summary: z.string().nullable(), risk: z.enum(['auto', 'notify', 'approve_required']),
  state: z.enum(['pending', 'approved', 'rejected', 'expired']), decided_by: z.string().nullable(), decided_at: timestamp.nullable(),
  reason: z.string().nullable(), expires_at: timestamp.nullable(), created_at: timestamp, executed_at: timestamp.nullable() }).strict();

export const NativeEvidencePayloadV1 = z.discriminatedUnion('record_kind', [
  z.object({ record_kind: z.literal('action'), record_id: uuid, record: NativeAction }).strict(),
  z.object({ record_kind: z.literal('attempt'), record_id: uuid, record: NativeAttempt }).strict(),
  z.object({ record_kind: z.literal('approval'), record_id: uuid, record: NativeApproval }).strict(),
]);
export const NativeEvidenceEventV1 = EventEnvelopeV1.superRefine((event, ctx) => {
  const result = NativeEvidencePayloadV1.safeParse(event.payload);
  if (!result.success) { ctx.addIssue({ code: 'custom', message: 'invalid native AUTH evidence payload v1' }); return; }
  const payload = result.data;
  if (event.event_type !== `platform.${payload.record_kind}.state_recorded` || event.event_class !== 'fact' ||
      event.subject_type !== 'EvidenceRecord' || event.subject_version !== 1 ||
      payload.record_id !== payload.record.id || payload.record.org_id !== event.company_id)
    ctx.addIssue({ code: 'custom', message: 'native evidence identity mismatch' });
  if (payload.record_kind === 'action' && (payload.record.intent.org_id !== event.company_id || event.correlation_id !== payload.record.id))
    ctx.addIssue({ code: 'custom', message: 'native action identity mismatch' });
  if (payload.record_kind === 'attempt' && event.correlation_id !== payload.record.action_id)
    ctx.addIssue({ code: 'custom', message: 'native attempt action mismatch' });
});
