'use client';

import { useState } from 'react';
import { previewPricing, type PricingConfig, type PricingInput, type PricingSnapshot } from '../../src/platform/pricing/versioned';

// Staged console component, adapted from the preserved September pricing editor.
// No route mounts this until AUTH-01 acceptance. The eventual server callbacks
// must use requireOperator + the existing AUTHZ tool boundary on every request.
export interface PricingEditorProps {
  initialConfig: PricingConfig; initialInput: PricingInput; revision: number;
  accounts: Array<{ id:string; name:string }>;
  save?: (config:PricingConfig,expectedRevision:number,reason:string)=>Promise<{revision:number;versionId:string}>;
  activate?: (versionId:string,revision:number,input:PricingInput,reason:string)=>Promise<void>;
}
const field='border rounded px-3 py-2 w-full bg-white text-zinc-900';
const button='border rounded px-4 py-2 disabled:opacity-40';
export default function PricingEditor(props:PricingEditorProps) {
  const [config,setConfig]=useState(props.initialConfig),[input,setInput]=useState(props.initialInput);
  const [bookId,setBookId]=useState(config.books[0].id),[revision,setRevision]=useState(props.revision),[versionId,setVersionId]=useState<string|null>(null);
  const [dirty,setDirty]=useState(true),[busy,setBusy]=useState(false),[reason,setReason]=useState(''),[message,setMessage]=useState('');
  const [preview,setPreview]=useState<PricingSnapshot|null>(null),[previous,setPrevious]=useState<PricingSnapshot|null>(null);
  const book=config.books.find(b=>b.id===bookId)!;
  const edit=(patch:Partial<PricingConfig>)=>{setConfig({...config,...patch});setDirty(true);setPreview(null);};
  const editInput=(patch:Partial<PricingInput>)=>{setInput({...input,...patch});setPreview(null);};
  function calculate(){
    const result=previewPricing(config,input);
    if(result.status==='blocked'){setPreview(null);setMessage(result.reason);return;}
    setPrevious(preview??previous);setPreview(result.snapshot);setMessage('Preview calculated. Review prices, freight, tax and terms before activation.');
  }
  async function save(){
    if(!props.save)return;setBusy(true);
    try {const result=await props.save(config,revision,reason);setRevision(result.revision);setVersionId(result.versionId);setDirty(false);setPreview(null);setMessage('Draft saved. Preview this version before activation.');}
    catch(error){setMessage(`${(error as Error).message} Your local draft has been retained.`);}finally{setBusy(false);}
  }
  async function activate(){
    if(!props.activate||!versionId)return;setBusy(true);
    try{await props.activate(versionId,revision,input,reason);setMessage('Version activated. Historical invoices retain their snapshots.');}
    catch(error){setMessage(`${(error as Error).message} Refresh and compare before retrying.`);}finally{setBusy(false);}
  }
  const text=(name:string,value:string,onChange:(value:string)=>void)=><label className="block text-sm space-y-1"><span>{name}</span><input aria-label={name} className={field} value={value} onChange={e=>onChange(e.target.value)}/></label>;
  const amount=(value:string)=>`${config.currency} ${(BigInt(value)/100n).toString()}.${(BigInt(value)%100n).toString().padStart(2,'0')}`;
  return <section className="space-y-6">
    <header><h1 className="text-2xl font-semibold">Pricing agreements</h1><p>Create a version, preview an account, then activate the saved configuration.</p></header>
    {!props.save&&<p role="status" className="p-3 border">Preview mode. Saving and activation are awaiting the protected operator service.</p>}
    {message&&<p role="status" aria-live="polite" className="p-3 border rounded">{message}</p>}
    <fieldset disabled={busy} className="grid md:grid-cols-3 gap-4">
      <legend>Version and effective dates</legend>
      {text('Version name',config.name,name=>edit({name}))}
      {text('Version identifier',config.version,version=>edit({version}))}
      {text('Effective timezone',config.timezone,timezone=>edit({timezone}))}
      {text('Effective from (including this instant)',config.effectiveFrom,effectiveFrom=>edit({effectiveFrom}))}
      {text('Effective until (excluding this instant, optional)',config.effectiveUntil??'',value=>edit({effectiveUntil:value||null}))}
      <label>Pricing date<select className={field} value={config.pricingDateBasis} onChange={e=>edit({pricingDateBasis:e.target.value as PricingConfig['pricingDateBasis']})}><option value="order">Order date</option><option value="dispatch">Dispatch date</option></select></label>
      <label>Volume tier quantity<select className={field} value={config.tierQuantityBasis} onChange={e=>edit({tierQuantityBasis:e.target.value as PricingConfig['tierQuantityBasis']})}><option value="ordered">Whole ordered quantity</option><option value="dispatched">Dispatched quantity</option></select></label>
      <label>Currency<select className={field} value={config.currency} onChange={e=>edit({currency:e.target.value as PricingConfig['currency']})}>{['NZD','AUD','USD','EUR','GBP','CAD'].map(c=><option key={c}>{c}</option>)}</select></label>
      <label>Tax percentage<input className={field} type="number" min="0" max="100" step="0.01" value={config.taxRateBps/100} onChange={e=>edit({taxRateBps:Math.round(Number(e.target.value)*100)})}/></label>
    </fieldset>
    <fieldset disabled={busy} className="space-y-3"><legend>Product prices</legend>
      <label>Price book<select className={field} value={bookId} onChange={e=>setBookId(e.target.value)}>{config.books.map(b=><option key={b.id}>{b.id}</option>)}</select></label>
      <table className="w-full text-left"><thead><tr><th>Product</th><th>Unit price (cents)</th></tr></thead><tbody>{book.entries.map((entry,index)=><tr key={entry.productId}><td>{entry.productId}</td><td><input className={field} inputMode="numeric" aria-label={`Price ${entry.productId}`} value={entry.unitPrice} onChange={e=>edit({books:config.books.map(b=>b.id!==bookId?b:{...b,entries:b.entries.map((item,n)=>n===index?{...item,unitPrice:e.target.value}:item)})})}/></td></tr>)}</tbody></table>
      <p>Price precedence: {config.pricePrecedence.join(' → ')}. Discounts {config.discountOnSpecialPrice?'also apply to negotiated and tier prices':'apply to book prices only'}.</p>
      <label>Discount combination<select className={field} value={config.discountCombination} onChange={e=>edit({discountCombination:e.target.value as PricingConfig['discountCombination']})}><option value="single">One applicable discount</option><option value="sequential">Apply in configured order</option></select></label>
      {config.discounts.map((rule,index)=><div className="grid grid-cols-3 gap-3" key={rule.id}><span>{rule.id} · {rule.productId}</span><span>{rule.discount.kind==='percent'?'Percentage in basis points':'Fixed discount in cents'}</span><input className={field} inputMode="numeric" aria-label={`Discount ${rule.id}`} value={rule.discount.kind==='percent'?rule.discount.bps:rule.discount.amount} onChange={e=>edit({discounts:config.discounts.map((r,n)=>n!==index?r:{...r,discount:r.discount.kind==='percent'?{kind:'percent',bps:Number(e.target.value)}:{kind:'fixed',amount:e.target.value}})})}/></div>)}
    </fieldset>
    <fieldset disabled={busy} className="space-y-3"><legend>Shipping</legend>
      <label><input type="checkbox" checked={config.shipping.enabled} onChange={e=>edit({shipping:{enabled:e.target.checked,rules:e.target.checked?props.initialConfig.shipping.rules:[]}})}/> Enable shipping</label>
      {config.shipping.rules.map((rule,index)=><div className="grid md:grid-cols-3 gap-3" key={rule.id}><span>{rule.id}</span><label>Charge method<select className={field} value={rule.mode.kind} onChange={e=>{
        const kind=e.target.value as typeof rule.mode.kind;
        const mode:typeof rule.mode=kind==='fixed'?{kind,amount:'0'}:kind==='adjusted'?{kind,fixed:'0',markupBps:0}:{kind};
        edit({shipping:{...config.shipping,rules:config.shipping.rules.map((r,n)=>n===index?{...r,mode}:r)}});
      }}>{['actual','adjusted','fixed','free','manual'].map(mode=><option key={mode}>{mode}</option>)}</select></label>
      {'amount' in rule.mode&&text('Fixed freight (cents)',rule.mode.amount,value=>edit({shipping:{...config.shipping,rules:config.shipping.rules.map((r,n)=>n===index?{...r,mode:{kind:'fixed',amount:value}}:r)}}))}
      <p>{rule.chargingBasis==='order_schedule'?'Uses the explicit order allocation schedule':'Charges each dispatch'}</p></div>)}
    </fieldset>
    <fieldset disabled={busy} className="grid md:grid-cols-3 gap-4"><legend>Preview</legend>
      <label>Account<select className={field} value={input.accountId} onChange={e=>editInput({accountId:e.target.value})}>{props.accounts.map(a=><option key={a.id} value={a.id}>{a.name}</option>)}</select></label>
      {text('Order date',input.orderAt,orderAt=>editInput({orderAt}))}
      {text('Dispatch date',input.dispatchAt??'',value=>editInput({dispatchAt:value||null}))}
      {input.lines.map((line,index)=><label key={line.lineId}>Dispatched quantity · {line.description}<input className={field} type="number" min="1" max={line.ordered} value={line.dispatched} onChange={e=>editInput({lines:input.lines.map((l,n)=>n===index?{...l,dispatched:Number(e.target.value)}:l)})}/></label>)}
    </fieldset>
    <div className="flex gap-3"><button className={button} disabled={busy} onClick={calculate}>Preview charges</button><span>{dirty?'Unsaved changes':`Saved revision ${revision}`}</span></div>
    {preview&&<div className="space-y-3"><h2 className="text-xl">Charge explanation</h2><table className="w-full text-left"><thead><tr><th>Item</th><th>Quantity</th><th>Base unit</th><th>Discount/unit</th><th>Final unit</th><th>Line amount</th></tr></thead><tbody>{preview.lines.map(l=><tr key={l.lineId}><td>{l.description}<small className="block">{l.explanation}</small></td><td>{l.dispatched}</td><td>{amount(l.baseUnitPrice)}</td><td>{amount(l.discountPerUnit)}</td><td>{amount(l.unitPrice)}</td><td>{amount(l.lineAmount)}</td></tr>)}</tbody></table><p>Carrier cost: {preview.freight.carrier?amount(preview.freight.carrier.cost):'Unknown / not supplied'}. Customer freight: {amount(preview.freight.amount)}. {preview.freight.explanation}</p><p>Tax {amount(preview.tax.amount)} · Total <strong>{amount(preview.total)}</strong> · Due {preview.terms.dueDate}</p>{previous&&<p>Previous preview total {amount(previous.total)}. Current total {amount(preview.total)}.</p>}</div>}
    {text('Reason for configuration change',reason,setReason)}
    <div className="flex gap-3"><button className={button} disabled={busy||!props.save||!reason.trim()} onClick={save}>Save new version</button><button className={button} disabled={busy||dirty||!preview||!versionId||!props.activate||!reason.trim()} onClick={activate}>Activate saved version</button></div>
  </section>;
}
