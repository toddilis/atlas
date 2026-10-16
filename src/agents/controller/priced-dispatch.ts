import { supabase } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';
import { readDispatch, type DispatchContext } from '../../platform/dispatch/read.js';
import { calculatePricing, PricingConfigSchema, PricingInputSchema, selectShippingRule } from '../../platform/pricing/versioned.js';

/** Bounded internal BILL adapter. AUTHZ owns the callable tool and trusted context.
 * The retailer, its tax treatment, the order reference, the part order and any carrier
 * cost come from the database, never from the request; SQL checks each again under the order lock. Billing
 * is Shopify-only until another source provides an order account contract. */
export async function draftPricedDispatch(context: DispatchContext, request: {
  dispatchId: string; pricingVersionId: string; input: unknown;
}) {
  const sb=supabase();
  const {data:existing,error:existingError}=await sb.from('invoice_calculation_snapshots').select('invoice_id,id,snapshot,document,content_hash')
    .eq('org_id',context.orgId).eq('source_id',context.sourceId).eq('dispatch_id',request.dispatchId).maybeSingle();
  if(existingError) throw existingError;
  // Historical retries do not require still-valid global rates or carrier quotes.
  if(existing) return {invoiceId:existing.invoice_id,snapshotId:existing.id,reused:true};
  const dispatch=await readDispatch(context,request.dispatchId);
  if(!dispatch || dispatch.state!=='eligible' || !dispatch.source_occurred_at) throw new Error('billing: eligible timestamped dispatch required');
  const input=PricingInputSchema.parse(request.input);
  if(input.businessId!==context.orgId || input.orderKey!==dispatch.order_key || input.dispatchKey!==dispatch.source_dispatch_key) throw new Error('billing: source/business binding mismatch');
  const {data:source,error:sourceError}=await sb.from('dispatch_sources').select('provider').eq('org_id',context.orgId).eq('id',context.sourceId).single();
  if(sourceError) throw sourceError;
  if(source.provider!=='shopify') throw new Error('billing: order retailer contract required for this dispatch source');
  const {data:order,error:orderError}=await sb.from('shopify_orders').select('shopify_customer_id,shopify_order_name').eq('org_id',context.orgId).eq('id',dispatch.order_key).single();
  if(orderError) throw orderError;
  if(!order.shopify_order_name) throw new Error('billing: order display reference unavailable');
  const {data:customer,error:customerError}=await sb.from('shopify_customers').select('account_id')
    .eq('org_id',context.orgId).eq('shopify_customer_id',order.shopify_customer_id??'').maybeSingle();
  if(customerError) throw customerError;
  if(!customer?.account_id) throw new Error('billing: order retailer unknown; link the Shopify customer to an account');
  const {data:account,error:accountError}=await sb.from('accounts').select('tax_exempt').eq('org_id',context.orgId).eq('id',customer.account_id).single();
  if(accountError) throw accountError;
  input.accountId=customer.account_id; input.taxExempt=account.tax_exempt;
  const {data:orderDispatches,error:orderDispatchError}=await sb.from('dispatches').select('id')
    .eq('org_id',context.orgId).eq('source_id',context.sourceId).eq('order_key',dispatch.order_key);
  if(orderDispatchError) throw orderDispatchError;
  const {count,error:partsError}=await sb.from('invoice_calculation_snapshots').select('id',{count:'exact',head:true})
    .eq('org_id',context.orgId).in('dispatch_id',(orderDispatches??[]).map(d=>d.id));
  if(partsError) throw partsError;
  input.priorParts=count??0;
  const {data:version,error:versionError}=await sb.from('pricing_versions').select('config').eq('org_id',context.orgId).eq('id',request.pricingVersionId).single();
  if(versionError) throw versionError;
  // Only a part whose rule charges carrier cost uses one, and only the carrier adapter's latest
  // stored record for this shipment can set it. Otherwise none is attached, so a disabled or
  // fixed-rate shipping setup, or a later freight-free part, is never blocked by a quote.
  const rule=selectShippingRule(PricingConfigSchema.parse(version.config),input);
  const carriesFreight=rule!==null && !(rule.chargingBasis==='first_part' && input.priorParts>0);
  input.carrier=null;
  if(carriesFreight && (rule.mode.kind==='actual' || rule.mode.kind==='adjusted')){
    const {data:evidence,error:evidenceError}=await sb.from('carrier_cost_evidence').select('*').eq('org_id',context.orgId).eq('dispatch_id',dispatch.id)
      .order('observed_at',{ascending:false}).order('recorded_at',{ascending:false}).limit(1).maybeSingle();
    if(evidenceError) throw evidenceError;
    input.carrier=evidence&&Date.parse(evidence.expires_at)>Date.now()?{businessId:context.orgId,connectionId:evidence.carrier_connection,
      shipmentKey:dispatch.source_dispatch_key,quoteId:evidence.quote_key,observedAt:evidence.observed_at,expiresAt:evidence.expires_at,
      currency:evidence.currency,taxBasis:'exclusive',cost:String(evidence.cost_minor)}:null;
  }
  input.dispatchAt=dispatch.source_occurred_at;
  input.evaluatedAt=new Date().toISOString();
  // The draft is the invoice date; SQL rejects invoice-dated terms from any other day.
  if(input.terms.kind==='following_month_day') input.terms.invoiceAt=input.evaluatedAt;
  const productIds=input.lines.map(l=>l.productId);
  const {data:products,error:productError}=await sb.from('products').select('id,sku,display_name').eq('org_id',context.orgId).eq('active',true).in('id',productIds);
  if(productError) throw productError;
  if(input.lines.length!==dispatch.lines.length) throw new Error('billing: each dispatch line must be represented');
  input.lines=input.lines.map(line=>{
    const source=dispatch.lines.find(l=>l.id===line.lineId);
    const product=products?.find(p=>p.id===line.productId);
    if(!source || !product || source.item_key!==product.sku) throw new Error('billing: exact product/line mapping required');
    return {...line,description:product.display_name,ordered:source.ordered_quantity,dispatched:source.quantity};
  });
  const snapshot=calculatePricing(version.config,input);
  const {data,error}=await sb.rpc('draft_dispatch_invoice',{
    p_org_id:context.orgId,p_source_id:context.sourceId,p_dispatch_id:dispatch.id,p_source_revision:dispatch.source_revision,
    p_pricing_version_id:request.pricingVersionId,p_snapshot:snapshot as unknown as Json,p_order_reference:order.shopify_order_name,
  });
  if(error) throw error;
  return data;
}
