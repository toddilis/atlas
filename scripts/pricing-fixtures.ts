import { config, input } from '../test/fixtures/pricing/synthetic.js';
import { calculatePricing } from '../src/platform/pricing/versioned.js';
// Optional two-digit id prefix gives each probe its own synthetic business.
const prefix=/^[0-9]{2}$/.test(process.argv[2]??'') ? process.argv[2]! : '63';
const company=`${prefix}000000-0000-4000-8000-000000000001`;
const account=`${prefix}000000-0000-4000-8000-000000000002`;
const product=`${prefix}000000-0000-4000-8000-000000000003`;
const c=config(); c.businessId=company; c.pricingDateBasis='dispatch';
c.books[0]!.entries[0]!.productId=product; c.bindings=[{accountId:account,bookId:'book'}]; c.discounts=[]; c.tiers[0]!.productId=product;
const i=input(); i.businessId=company;i.accountId=account;i.lines[0]!.productId=product;
const a=calculatePricing(c,i); i.dispatchKey='dispatch-b';i.lines[0]!.dispatched=60;const b=calculatePricing(c,i);
// Scheduled price change after parts A/B were dispatched, and a later order dispatched under it.
// late_v1 is the stale preview a caller could still hold for that later dispatch.
const c2=structuredClone(c); c2.version='v2'; c2.effectiveFrom='2026-10-03T00:00:00+13:00'; c2.tiers[0]!.unitPrice='1200';
const late=input(); late.businessId=company; late.accountId=account; late.lines[0]!.productId=product;
late.orderKey='order-200'; late.dispatchKey='dispatch-c'; late.orderAt='2026-10-03T12:00:00+13:00';
late.dispatchAt='2026-10-04T09:00:00+13:00'; late.evaluatedAt='2026-10-04T10:00:00+13:00'; late.lines[0]!.dispatched=100;
late.freightSchedule={id:'schedule-2',total:'1000',allocations:[{dispatchKey:'dispatch-c',amount:'1000'}]};
const fixtures={company,account,product,config:c,config_v2:c2,a,b,late_v1:calculatePricing(c,late),late_v2:calculatePricing(c2,late)};
for(const [name,value] of Object.entries(fixtures)) {
  const text=typeof value==='string' ? value : JSON.stringify(value);
  console.log(`set test.pricing_${name} = '${text.replaceAll("'","''")}';`);
}
