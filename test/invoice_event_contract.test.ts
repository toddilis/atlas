import test from 'node:test';
import assert from 'node:assert/strict';
import { ControllerEventV1 } from '../src/platform/contracts/controller-v1.js';
test('invoice drafted v1 reader preserves exact snapshot identity and rejects substitutions', () => {
  const reference = { company_id: 'a', id: 'snapshot-a', revision: 1 };
  const event = { event_id: 'draft-a', event_type: 'controller.invoice.drafted', event_version: 1, company_id: 'a',
    connection_id: 'source-a', occurred_at: '2026-10-01T00:00:00Z', observed_at: '2026-10-01T00:00:00Z', producer: 'controller',
    subject_type: 'Invoice', subject_id: 'invoice-a', subject_version: 1, correlation_id: 'part-a', causation_id: null,
    source_refs: [], evidence_refs: [], event_class: 'fact', payload: { company_id: 'a', invoice_id: 'invoice-a', invoice_revision: 1,
      dispatch_id: 'dispatch-a', part_id: 'part-a', calculation_snapshot_ref: { ...reference, type: 'InvoiceCalculationSnapshot' },
      document_snapshot_ref: { ...reference, type: 'InvoiceDocumentSnapshot' }, total: { amount_minor: '37260', currency: 'NZD', scale: 2 } } };
  assert.equal(ControllerEventV1.safeParse(event).success, true);
  for (const changed of [{ ...event, subject_id: 'wrong' }, { ...event, event_class: 'proposal' },
    { ...event, payload: { ...event.payload, document_snapshot_ref: { ...reference, company_id: 'b', type: 'InvoiceDocumentSnapshot' } } },
    { ...event, payload: { ...event.payload, invoice_revision: 2 } }, { ...event, payload: { invoice_id: 'legacy-event' } }]) {
    assert.equal(ControllerEventV1.safeParse(changed).success, false);
  }
});
