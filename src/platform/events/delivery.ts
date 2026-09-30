import { z } from 'zod';
import { supabase, orgId } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';
import { ControllerEventV1, EventEnvelopeV1 } from '../contracts/controller-v1.js';
import { NativeEvidenceEventV1 } from '../evidence/native-contract.js';
import { assertEffectsAllowed, withProjectionReplay } from './context.js';

/** Scope comes from the trusted deployment, never from a request company field. */
export function assertEventCompany(value: unknown, company = orgId()): void {
  if (Array.isArray(value)) { value.forEach(v => assertEventCompany(v, company)); return; }
  if (value !== null && typeof value === 'object') {
    const object = value as Record<string, unknown>;
    if ('company_id' in object && object.company_id !== company) throw new Error('cross-company event reference');
    if ('org_id' in object && object.org_id !== company) throw new Error('cross-company native record');
    Object.values(object).forEach(v => assertEventCompany(v, company));
  }
}

export function parsePublishedEvent(input: unknown, company = orgId()) {
  const event = EventEnvelopeV1.parse(input);
  assertEventCompany(event, company);
  if (Buffer.byteLength(JSON.stringify(event)) > 262144) throw new Error('event exceeds 256 KiB');
  if (event.event_type.startsWith('platform.')) return NativeEvidenceEventV1.parse(event);
  return ControllerEventV1.parse(event);
}

/** Pure publication only. Domain mutations must call the SQL helper IN their transaction. */
export async function publishEvent(input: unknown, sourceKey: string, consumers: string[] = []): Promise<string> {
  assertEffectsAllowed();
  const event = parsePublishedEvent(input);
  const { data, error } = await supabase().rpc('publish_platform_event', {
    p_org_id: orgId(), p_envelope: event as unknown as Json,
    p_source_key: z.string().min(1).parse(sourceKey), p_consumers: consumers.map(v => z.string().min(1).parse(v)),
  });
  if (error) throw error;
  return z.string().uuid().parse(data);
}

const Claim = z.object({ event_id: z.string(), lease_token: z.string().uuid(), envelope: z.unknown() });
export async function projectNextEvent(consumer: string, generation = 'live'): Promise<string | null> {
  // All canonical consumers are projection-only, including normal recovery.
  return withProjectionReplay(async () => {
    const { data, error } = await supabase().rpc('claim_event_receipt', {
      p_org_id: orgId(), p_consumer: consumer, p_generation: generation,
    });
    if (error) throw error;
    if (data === null) return null;
    const claim = Claim.parse(data);
    // SQL owns durable envelope version checks and projection semantics. Native/domain
    // payloads stay unchanged in this generic read model; interpretation is by readers.
    const result = await supabase().rpc('apply_event_projection', {
      p_org_id: orgId(), p_consumer: consumer, p_generation: generation,
      p_event_id: claim.event_id, p_lease_token: claim.lease_token,
    });
    if (result.error) throw result.error;
    return z.string().parse(result.data);
  });
}

export async function enqueueReplay(consumer: string, generation: string, eventIds: string[]): Promise<number> {
  const { data, error } = await supabase().rpc('enqueue_event_replay', {
    p_org_id: orgId(), p_consumer: consumer, p_generation: generation, p_event_ids: eventIds,
  });
  if (error) throw error;
  return z.number().parse(data);
}

export async function readEventDelivery(eventId: string) {
  const { data, error } = await supabase().rpc('read_event_delivery', { p_org_id: orgId(), p_event_id: eventId });
  if (error) throw error;
  return data;
}
