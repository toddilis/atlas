// Event types are namespaced by source.domain.verb. Adding a new event = adding a member here
// + a projector registration. Payload shape is intentionally untyped at this layer; each
// projector validates its own slice.
export type EventType =
  | 'shopify.customer.upserted'
  | 'shopify.order.upserted'
  | 'shopify.fulfillment.created'
  | 'stripe.invoice.paid'
  | 'controller.fulfillment.routed'
  | 'controller.invoice.drafted'
  | 'controller.invoice.issued'
  | 'controller.payment.recorded'
  | 'system.org.bootstrapped';

export interface EventInput {
  type: EventType;
  source: string;                      // 'shopify_webhook', 'controller', etc.
  agentName?: string;
  subjectType?: string;
  subjectId?: string | null;
  payload: Record<string, unknown>;
  occurredAt?: Date;
  /**
   * Per-(source, external id) dedup key. The DB unique constraint makes appends idempotent —
   * a duplicate webhook delivery will conflict here, not poison the projection.
   */
  idempotencyKey?: string;
}

export interface AppendedEvent {
  id: string;
  seq: number;
  type: EventType;
  source: string;
  agentName: string | null;
  subjectType: string | null;
  subjectId: string | null;
  payload: Record<string, unknown>;
  occurredAt: string;
  appendedAt: string;
  idempotencyKey: string | null;
}
