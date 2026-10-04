import test from 'node:test';
import assert from 'node:assert/strict';
import { config,input } from './fixtures/pricing/synthetic.js';
import { calculatePricing } from '../src/platform/pricing/versioned.js';
import { selectPricingVersion,previewPriceImport } from '../src/platform/pricing/configuration.js';
import { renderInvoiceDocument } from '../src/agents/controller/invoice-document.js';

test('new effective version supersedes an open-ended version; expired newer version cannot fall back',()=>{
  const first=config(),next=config();next.version='v2';next.effectiveFrom='2026-11-01T00:00:00+13:00';next.effectiveUntil='2026-12-01T00:00:00+13:00';
  assert.equal(selectPricingVersion([first,next],'wholesale','2026-10-31T10:59:59Z').version,'v1');
  assert.equal(selectPricingVersion([first,next],'wholesale','2026-10-31T11:00:00Z').version,'v2');
  assert.throws(()=>selectPricingVersion([first,next],'wholesale','2026-12-01T00:00:00Z'),/no effective/);
  assert.throws(()=>selectPricingVersion([first,{...next,businessId:'other'}],'wholesale','2026-11-01T00:00:00Z'),/cross-business/);
});
test('import repeated produces exact no-change diff and preserves negotiated agreements',()=>{
  const c=config();c.negotiated=[{id:'deal',accountId:'retailer-a',productId:'widget',unitPrice:'700'}];
  const first=previewPriceImport(c,'book',[{sourceRow:2,productId:'widget',unitPrice:'1200'}]);
  assert.equal(first.changes[0]!.previous,'1000');assert.equal(first.activated,false);assert.equal(c.books[0]!.entries[0]!.unitPrice,'1000');
  const second=previewPriceImport(first.draft,'book',[{sourceRow:2,productId:'widget',unitPrice:'1200'}]);
  assert.equal(second.requiresNewVersion,false);assert.equal(second.draft.negotiated[0]!.unitPrice,'700');
  assert.throws(()=>previewPriceImport(c,'book',[{sourceRow:2,productId:'missing',unitPrice:'1200'}]),/unmapped/);
});
test('reused original regressions: negotiated threshold, increased override and zero freight allocation',()=>{
  const c=config(),i=input();c.negotiated=[{id:'deal',accountId:null,productId:'widget',unitPrice:'800'}];
  const rule=c.shipping.rules[0]!;rule.chargingBasis='per_dispatch';rule.freeThreshold={amount:'35000',valueBasis:'dispatch',afterDiscount:false,includesTax:false};i.freightSchedule=null;
  assert.equal(calculatePricing(c,i).freight.amount,'1000'); // 40×800=32000, not catalogue40×1000.
  i.lines[0]!.override={amount:'1200',actor:'operator',reason:'Synthetic finishing'};
  const result=calculatePricing(c,i);assert.equal(result.lines[0]!.discountPerUnit,'0');assert.equal(result.lines[0]!.overrideDelta,'400');
  const zero=input();zero.dispatchKey='dispatch-c';zero.freightSchedule!.allocations.push({dispatchKey:'dispatch-c',amount:'0'});
  assert.equal(calculatePricing(config(),zero).freight.amount,'0');
});
test('print renders immutable quantities/terms/order reference, escapes text and never converts money to float',()=>{
  const c=config(),i=input();i.lines[0]!.description='<script>bad</script>';const calculation=calculatePricing(c,i);
  const doc={schemaVersion:1 as const,company_id:c.businessId,invoiceId:'invoice-a',revision:1 as const,invoiceNumber:'SYN-A',orderReference:'#123',calculation};
  const html=renderInvoiceDocument(doc);assert.match(html,/#123/);assert.match(html,/>40</);assert.match(html,/NZD 372.60/);assert.match(html,/2026-11-20/);
  assert.doesNotMatch(html,/<script>/);assert.match(html,/&lt;script&gt;/);
  c.tiers[0]!.unitPrice='2000';assert.equal(renderInvoiceDocument(doc),html);
});
