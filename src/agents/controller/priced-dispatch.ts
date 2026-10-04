import { supabase } from '../../data/supabase.js';
import type { Json } from '../../data/database.types.js';
import { readDispatch, type DispatchContext } from '../../platform/dispatch/read.js';
import { calculatePricing, PricingInputSchema } from '../../platform/pricing/versioned.js';

/** Bounded internal BILL adapter. AUTHZ owns the callable tool and trusted context.
 * Order-date pricing is verified against canonical Shopify placed_at by SQL; generic
 * sources use dispatch-date pricing until their authoritative order contract exists. */
export async function draftPricedDispatch(context: DispatchContext, request: {
  dispatchId: string; pricingVersionId: string; orderReference: string; input: unknown;
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
  input.dispatchAt=dispatch.source_occurred_at;
  input.evaluatedAt=new Date().toISOString();
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
  const {data:version,error:versionError}=await sb.from('pricing_versions').select('config').eq('org_id',context.orgId).eq('id',request.pricingVersionId).single();
  if(versionError) throw versionError;
  const snapshot=calculatePricing(version.config,input);
  const {data,error}=await sb.rpc('draft_dispatch_invoice',{
    p_org_id:context.orgId,p_source_id:context.sourceId,p_dispatch_id:dispatch.id,p_source_revision:dispatch.source_revision,
    p_pricing_version_id:request.pricingVersionId,p_snapshot:snapshot as unknown as Json,p_order_reference:request.orderReference,
  });
  if(error) throw error;
  return data;
}
