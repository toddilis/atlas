import assert from 'node:assert/strict';
import test from 'node:test';
import { renderStatementDocument, type StatementDocumentData } from '../src/agents/controller/statement-document.js';

const data = (): StatementDocumentData => ({
  accountName: 'Retailer & Sons', state: 'draft', currency: 'NZD',
  periodStart: '1 Oct 2026', asOf: '31 Oct 2026', generatedOn: '31 Oct 2026',
  openingCents: 0, chargesCents: 20000, paymentsCents: 5000, closingCents: 15000,
  agingCurrentCents: 0, aging30Cents: 15000, aging60Cents: 0, aging90Cents: 0,
  aging90PlusCents: 0, creditCents: 0,
  lines: [
    { lineType: 'opening', occurredOn: '1 Oct 2026', description: 'Opening balance', amountCents: 0, runningBalanceCents: 0 },
    { lineType: 'invoice', occurredOn: '2 Oct 2026', description: 'Invoice <INV-7>', amountCents: 20000, runningBalanceCents: 20000 },
    { lineType: 'payment', occurredOn: '20 Oct 2026', description: 'Payment received', amountCents: -5000, runningBalanceCents: 15000 },
    { lineType: 'closing', occurredOn: '31 Oct 2026', description: 'Closing balance', amountCents: 15000, runningBalanceCents: 15000 },
  ],
});

test('statement document renders the snapshot, escapes text and keeps payment signs', () => {
  const html = renderStatementDocument(data());
  assert.match(html, /Statement of account/);
  assert.match(html, /To: Retailer &amp; Sons/);
  assert.match(html, /Invoice &lt;INV-7&gt;/);
  assert.doesNotMatch(html, /<INV-7>/);
  assert.match(html, /NZD 200.00/);           // invoice line
  assert.match(html, /NZD -50.00/);           // payment keeps its negative sign
  assert.match(html, /closing NZD 150.00/);   // derivation line
  assert.match(html, /1–30 days<\/td><td>NZD 150.00/); // aging bucket
  assert.doesNotMatch(html, /VOID/);
  assert.doesNotMatch(html, /Credit/);        // zero credit is not printed
});

test('voided statements say so; profile wraps the document like an invoice', () => {
  const voided = renderStatementDocument({ ...data(), state: 'voided', voidedReason: 'superseded <b>now</b>' });
  assert.match(voided, /Statement \(VOID\)/);
  assert.match(voided, /VOID — superseded &lt;b&gt;now&lt;\/b&gt;/);
  const profiled = renderStatementDocument({ ...data(), creditCents: 700 }, {
    business: 'Display name', retailer: 'Retailer & Sons',
    legalName: 'Synthetic Fixtures Ltd', taxLabel: 'GST number', taxNumber: '123-456-789',
    address: '1 Example Street\nAuckland', paymentInstructions: 'Bank 00-0000-0000000-00\nReference the statement',
  });
  assert.match(profiled, /From: Synthetic Fixtures Ltd/);
  assert.match(profiled, /GST number: 123-456-789/);
  assert.match(profiled, /1 Example Street<br>Auckland/);
  assert.match(profiled, /Payment: Bank 00-0000-0000000-00<br>Reference the statement/);
  assert.match(profiled, /Credit<\/td><td>NZD -7.00/);
  // Missing profile fields fall back to the display name and print nothing extra.
  const bare = renderStatementDocument(data(), { business: 'Display name', retailer: 'Retailer & Sons' });
  assert.match(bare, /From: Display name/);
  assert.doesNotMatch(bare, /Tax number/);
  assert.doesNotMatch(bare, /Payment:/);
});
