import { config, input } from '../test/fixtures/pricing/synthetic.js';
import { calculatePricing, type PricingInput } from '../src/platform/pricing/versioned.js';
import { consignmentEvidence } from '../src/integrations/gosweetspot/consignment.js';
// Optional two-digit id prefix gives each probe its own synthetic business.
const prefix=/^[0-9]{2}$/.test(process.argv[2]??'') ? process.argv[2]! : '63';
const uuid=(n:number)=>`${prefix}000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
const company=uuid(1), account=uuid(2), product=uuid(3), other=uuid(4);
// Shopify order ids are the DATA-01 order keys. other is a tax-exempt retailer with its own price.
const order100=uuid(100), order200=uuid(200), order500=uuid(500);
const c=config(); c.businessId=company; c.pricingDateBasis='dispatch';
c.books[0]!.entries[0]!.productId=product; c.bindings=[{accountId:account,bookId:'book'},{accountId:other,bookId:'book'}];
c.discounts=[]; c.tiers[0]!.productId=product; c.negotiated=[{id:'other-deal',accountId:other,productId:product,unitPrice:'700'}];
// VICE's rule shape (PLAN D15): the first part pays that shipment's carrier rate, later parts none.
c.shipping.rules[0]!.mode={kind:'actual'};
// A dispatch's first-part carrier cost exactly as the GoSweetSpot adapter maps a booked
// shipment (synthetic: NZ$10.00 for the consignment carrying the dispatch's tracking number).
const quote=(dispatchKey:string,observedAt:string)=>{
  const e=consignmentEvidence({Consignments:[{ConsignmentId:`c-${dispatchKey}`,Connote:`SYN-${dispatchKey}`,Cost:10}]},[`SYN-${dispatchKey}`],
    {siteId:'synthetic',currency:'NZD',validityDays:3650},new Date(observedAt));
  return {businessId:company,connectionId:e.carrierConnection,shipmentKey:dispatchKey,quoteId:e.quoteKey,observedAt:e.observedAt,
    expiresAt:e.expiresAt,currency:e.currency,taxBasis:'exclusive' as const,cost:e.costMinor.toString()};
};
const part=(edit:(i:PricingInput)=>void)=>{
  const i=input(); i.businessId=company; i.accountId=account; i.orderKey=order100; i.lines[0]!.productId=product; edit(i); return i;
};
const a=part(i=>{i.carrier=quote('dispatch-a','2026-10-02T09:30:00+13:00');});
const b=part(i=>{i.dispatchKey='dispatch-b'; i.lines[0]!.dispatched=60; i.priorParts=1;});
const bFirst=part(i=>{i.dispatchKey='dispatch-b'; i.lines[0]!.dispatched=60; i.carrier=quote('dispatch-b','2026-10-02T09:30:00+13:00');});
// Scheduled price change after parts A/B were dispatched, and a later order dispatched under it.
// late_v1 is the stale preview a caller could still hold for that later dispatch.
const c2=structuredClone(c); c2.version='v2'; c2.effectiveFrom='2026-10-03T00:00:00+13:00'; c2.tiers[0]!.unitPrice='1200';
const late=part(i=>{i.orderKey=order200; i.dispatchKey='dispatch-c'; i.orderAt='2026-10-03T12:00:00+13:00';
  i.dispatchAt='2026-10-04T09:00:00+13:00'; i.evaluatedAt='2026-10-04T10:00:00+13:00'; i.lines[0]!.dispatched=100;
  i.carrier=quote('dispatch-c','2026-10-04T09:30:00+13:00');});
const exempt=part(i=>{i.accountId=other; i.orderKey=order500; i.dispatchKey='dispatch-e'; i.lines[0]!.ordered=10; i.lines[0]!.dispatched=10;
  i.taxExempt=true; i.carrier=quote('dispatch-e','2026-10-02T09:30:00+13:00');});
// The other retailer's price for order 100's first part: a valid calculation for the wrong retailer.
const swap=part(i=>{i.accountId=other; i.taxExempt=true; i.carrier=quote('dispatch-a','2026-10-02T09:30:00+13:00');});
const fixtures={company,account,other_account:other,product,order_100:order100,order_200:order200,order_500:order500,config:c,config_v2:c2,
  a:calculatePricing(c,a),b:calculatePricing(c,b),b_first:calculatePricing(c,bFirst),
  late_v1:calculatePricing(c,late),late_v2:calculatePricing(c2,late),exempt:calculatePricing(c,exempt),swap:calculatePricing(c,swap)};
for(const [name,value] of Object.entries(fixtures)) {
  const text=typeof value==='string' ? value : JSON.stringify(value);
  console.log(`set test.pricing_${name} = '${text.replaceAll("'","''")}';`);
}
