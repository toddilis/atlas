import { config, input } from '../test/fixtures/pricing/contrast.js';
import { calculatePricing, type PricingInput } from '../src/platform/pricing/versioned.js';
// PORT-01: the contrasting business keeps its own two-digit id namespace.
const prefix=/^[0-9]{2}$/.test(process.argv[2]??'') ? process.argv[2]! : '75';
const uuid=(n:number)=>`${prefix}000000-0000-4000-8000-${n.toString().padStart(12,'0')}`;
const company=uuid(1), account=uuid(2), product=uuid(3);
const order1=uuid(100), order2=uuid(200);
const c=config(); c.businessId=company;
c.books[0]!.entries[0]!.productId=product; c.negotiated[0]!.accountId=account; c.negotiated[0]!.productId=product;
c.tiers[0]!.productId=product; for(const d of c.discounts) d.productId=product;
const part=(edit:(i:PricingInput)=>void)=>{
  const i=input(); i.businessId=company; i.accountId=account; i.orderKey=order1; i.lines[0]!.productId=product; edit(i); return i;
};
// Part 1, 30 of 50 dispatched: the tier qualifies on the dispatched quantity and beats
// the negotiated price (tier-first precedence); both discounts stack on it in order
// ($18.00 → $17.10 → $16.85); the discounted part value 30 × $16.85 = $505.50 clears
// the $400 threshold, so this shipment's freight is waived.
const a=part(()=>{});
// Part 2, the remaining 20: below the tier, so the negotiated price beats the book
// ($19.50 → $18.53 → $18.28); $365.60 stays under the threshold, so this part pays its
// own $5.00 freight — per-dispatch, where VICE's first_part basis charges only part 1.
const b=part(i=>{i.dispatchKey='dispatch-p2'; i.lines[0]!.dispatched=20; i.priorParts=1;
  i.dispatchAt='2026-10-24T10:00:00-04:00'; i.evaluatedAt='2026-10-24T11:00:00-04:00';});
// A price change effective 21 Oct (tier → $16.00). Order 1 was placed on the 20th, so
// both its parts keep v1 although they dispatch after the change — the order-date
// basis, where VICE's dispatch-date basis gives the opposite outcome.
const c2=structuredClone(c); c2.version='v2'; c2.effectiveFrom='2026-10-21T00:00:00-04:00'; c2.tiers[0]!.unitPrice='1600';
// Order 2 is placed on the 22nd, after the change: v1 is stale for it, v2 prices it.
const late=part(i=>{i.orderKey=order2; i.dispatchKey='dispatch-p3'; i.orderAt='2026-10-22T09:00:00-04:00';
  i.dispatchAt='2026-10-23T10:00:00-04:00'; i.evaluatedAt='2026-10-23T11:00:00-04:00'; i.lines[0]!.ordered=25; i.lines[0]!.dispatched=25;});
const fixtures={company,account,product,order_1:order1,order_2:order2,config:c,config_v2:c2,
  a:calculatePricing(c,a),b:calculatePricing(c,b),late_v1:calculatePricing(c,late),late_v2:calculatePricing(c2,late)};
for(const [name,value] of Object.entries(fixtures)) {
  const text=typeof value==='string' ? value : JSON.stringify(value);
  console.log(`set test.port_${name} = '${text.replaceAll("'","''")}';`);
}
