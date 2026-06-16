// Base worker — the thin shared scaffolding deterministic-worker agents (Controller, future
// Ops, etc.) build on. Analytical and orchestrator kinds compose around the same primitives
// but typically don't subscribe to events in the same way.
//
// At Phase 0 this module is intentionally small: it bundles the activity + observation
// writers in one import path so concrete agents read cleanly. The shape stays compatible
// when the consolidation worker turns observations into retrievable memory.

import type { AppendedEvent } from '../events/types.js';
import { recordActivity, type ActivityKind } from './activity.js';
import { recordObservation, type ObservationKind } from '../memory/observations.js';

export interface WorkerContext {
  agentName: string;
  event: AppendedEvent;
}

export async function note(
  ctx: WorkerContext,
  kind: ActivityKind,
  summary: string,
  extra: { subjectType?: string; subjectId?: string | null; detail?: Record<string, unknown> } = {},
): Promise<void> {
  await recordActivity({
    agentName: ctx.agentName,
    kind,
    summary,
    eventId: ctx.event.id,
    subjectType: extra.subjectType,
    subjectId: extra.subjectId,
    detail: extra.detail,
  });
}

export async function observe(
  ctx: WorkerContext,
  kind: ObservationKind,
  content: string,
  extra: {
    subjectType?: string;
    subjectId?: string | null;
    confidence?: number;
    metadata?: Record<string, unknown>;
  } = {},
): Promise<void> {
  await recordObservation({
    agentName: ctx.agentName,
    kind,
    content,
    sourceEventId: ctx.event.id,
    subjectType: extra.subjectType,
    subjectId: extra.subjectId,
    confidence: extra.confidence,
    metadata: extra.metadata,
  });
}
