-- BILL-01 consumes DATA-01 allocation; EVENT-01 publish_platform_event is a runtime
-- prerequisite. Missing publication rolls the complete transaction back.
create table billing_order_groups (
  org_id uuid not null references orgs(id), source_id uuid not null, order_key text not null,
  number_base text not null, order_reference text not null, account_id uuid not null references accounts(id),
  freight_schedule jsonb, created_at timestamptz not null default now(),
  primary key(org_id,source_id,order_key), foreign key(org_id,source_id) references dispatch_sources(org_id,id),
  unique(org_id,number_base)
);
create table invoice_calculation_snapshots (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references orgs(id),
  invoice_id uuid not null references invoices(id), part_id uuid not null unique references dispatch_invoice_parts(id),
  source_id uuid not null, dispatch_id uuid not null, source_revision timestamptz not null,
  pricing_version_id uuid not null, revision integer not null default 1 check(revision=1),
  snapshot jsonb not null, content_hash text not null, document jsonb not null,
  created_at timestamptz not null default now(),
  foreign key(org_id,source_id,dispatch_id,part_id) references dispatch_invoice_parts(org_id,source_id,dispatch_id,id),
  foreign key(org_id,pricing_version_id) references pricing_versions(org_id,id),
  unique(invoice_id), unique(org_id,id)
);
create trigger invoice_calculations_immutable before update or delete on invoice_calculation_snapshots
  for each row execute function reject_dispatch_history_mutation();
create trigger billing_order_groups_immutable before update or delete on billing_order_groups
  for each row execute function reject_dispatch_history_mutation();

create function billing_suffix(p_index integer) returns text language plpgsql immutable as $$
declare v integer := p_index; s text := ''; begin
  if v < 1 then raise exception 'positive part index required'; end if;
  while v > 0 loop v:=v-1; s:=chr(65+v%26)||s; v:=v/26; end loop; return s;
end $$;

create function draft_dispatch_invoice(p_org_id uuid,p_source_id uuid,p_dispatch_id uuid,p_source_revision timestamptz,
  p_pricing_version_id uuid,p_snapshot jsonb,p_order_reference text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  d dispatches%rowtype; g billing_order_groups%rowtype; existing invoice_calculation_snapshots%rowtype;
  c pricing_versions%rowtype; l jsonb; dl dispatch_lines%rowtype; v_part uuid; v_invoice uuid; v_snapshot_id uuid:=gen_random_uuid();
  v_number text; v_index integer; v_subtotal numeric:=0; v_freight bigint; v_tax bigint; v_total bigint;
  v_schedule jsonb; v_document jsonb; v_hash text; v_account uuid; v_event jsonb;
begin
  select * into d from dispatches where org_id=p_org_id and source_id=p_source_id and id=p_dispatch_id;
  if not found then raise exception 'dispatch unavailable to business/source'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_source_id::text||':'||d.order_key,0));
  select * into existing from invoice_calculation_snapshots where org_id=p_org_id and dispatch_id=p_dispatch_id;
  if found then
    -- Retry/reprint returns original snapshot even after configuration/source changes.
    -- Corrections remain DATA-01 exceptions, never new charges.
    return jsonb_build_object('invoiceId',existing.invoice_id,'snapshotId',existing.id,'reused',true);
  end if;
  select * into d from dispatches where id=p_dispatch_id for update;
  if p_snapshot->>'businessId' is distinct from p_org_id::text or p_snapshot#>>'{input,businessId}' is distinct from p_org_id::text
    or p_snapshot#>>'{input,orderKey}' is distinct from d.order_key
    or p_snapshot#>>'{input,dispatchKey}' is distinct from d.source_dispatch_key then raise exception 'snapshot source/business mismatch'; end if;
  v_account := (p_snapshot#>>'{input,accountId}')::uuid;
  if not exists(select 1 from accounts where org_id=p_org_id and id=v_account) then raise exception 'account unavailable to business'; end if;
  if nullif(btrim(p_order_reference),'') is null then raise exception 'order display reference required'; end if;
  -- Lock the pricing timeline through save/activation and reject a preview whose
  -- selected effective version changed before commit.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':pricing',0));
  select v.* into c from pricing_versions v join pricing_activations a on a.version_id=v.id
    where v.org_id=p_org_id and (v.config->>'effectiveFrom')::timestamptz <= (p_snapshot->>'pricingAt')::timestamptz
    order by (v.config->>'effectiveFrom')::timestamptz desc limit 1;
  if not found or c.id is distinct from p_pricing_version_id or c.version_key is distinct from p_snapshot->>'configVersion'
    or (c.config->>'effectiveUntil' is not null and (p_snapshot->>'pricingAt')::timestamptz >= (c.config->>'effectiveUntil')::timestamptz)
    then raise exception 'stale or inactive pricing snapshot'; end if;
  if c.config->>'currency' is distinct from p_snapshot->>'currency' or c.config->>'taxRateBps' is distinct from p_snapshot#>>'{tax,rateBps}'
    or c.config->>'freightTaxable' is distinct from p_snapshot#>>'{tax,freightTaxable}'
    or c.config->>'timezone' is distinct from p_snapshot->>'timezone' then raise exception 'snapshot configuration mismatch'; end if;
  if jsonb_typeof(p_snapshot->'lines') is distinct from 'array' or jsonb_array_length(p_snapshot->'lines')=0 then raise exception 'snapshot lines required'; end if;
  if (select count(*) from dispatch_lines where dispatch_id=d.id and active) <> jsonb_array_length(p_snapshot->'lines')
    or (select count(distinct value->>'lineId') from jsonb_array_elements(p_snapshot->'lines')) <> jsonb_array_length(p_snapshot->'lines') then raise exception 'snapshot must include each dispatch line exactly once'; end if;
  for l in select value from jsonb_array_elements(p_snapshot->'lines') loop
    select * into dl from dispatch_lines where dispatch_id=d.id and active and id::text=l->>'lineId';
    if not found or dl.quantity::text is distinct from l->>'dispatched' or dl.ordered_quantity::text is distinct from l->>'ordered'
      then raise exception 'snapshot dispatched quantity mismatch'; end if;
    if not exists(select 1 from products where org_id=p_org_id and id::text=l->>'productId' and sku=dl.item_key) then raise exception 'snapshot product mapping mismatch'; end if;
    if coalesce(l->>'unitPrice','') !~ '^(0|[1-9][0-9]*)$' or coalesce(l->>'lineAmount','') !~ '^(0|[1-9][0-9]*)$'
      or (l->>'lineAmount')::numeric <> (l->>'unitPrice')::numeric * dl.quantity then raise exception 'snapshot line arithmetic mismatch'; end if;
    v_subtotal := v_subtotal+(l->>'lineAmount')::numeric;
  end loop;
  v_freight := (p_snapshot#>>'{freight,amount}')::bigint;
  v_tax := (p_snapshot#>>'{tax,amount}')::bigint; v_total := (p_snapshot->>'total')::bigint;
  if v_freight is null or v_freight<0 or v_tax is null or v_tax<0 or v_total is null or v_total<0
    or v_subtotal is distinct from (p_snapshot->>'subtotal')::numeric
    or v_tax::numeric <> floor((v_subtotal+case when (c.config->>'freightTaxable')::boolean then v_freight else 0 end)*(c.config->>'taxRateBps')::numeric/10000)
    or v_total::numeric <> v_subtotal+v_freight+v_tax then raise exception 'snapshot total arithmetic mismatch'; end if;
  v_schedule := nullif(p_snapshot#>'{freight,schedule}','null'::jsonb);
  select * into g from billing_order_groups where org_id=p_org_id and source_id=p_source_id and order_key=d.order_key;
  if found then
    if g.account_id<>v_account or g.order_reference<>p_order_reference or g.freight_schedule is distinct from v_schedule then raise exception 'order billing or freight schedule changed; correction required'; end if;
  else
    insert into billing_order_groups(org_id,source_id,order_key,number_base,order_reference,account_id,freight_schedule)
      values(p_org_id,p_source_id,d.order_key,next_invoice_number(p_org_id),p_order_reference,v_account,v_schedule) returning * into g;
  end if;
  if v_schedule is not null then
    if p_snapshot#>>'{freight,basis}' <> 'order_schedule'
      or (select count(*) from jsonb_array_elements(v_schedule->'allocations') x where x->>'dispatchKey'=d.source_dispatch_key and (x->>'amount')::bigint=v_freight) <> 1
      or (select count(distinct x->>'dispatchKey') from jsonb_array_elements(v_schedule->'allocations') x) <> jsonb_array_length(v_schedule->'allocations')
      or (select sum((x->>'amount')::numeric) from jsonb_array_elements(v_schedule->'allocations') x) <> (v_schedule->>'total')::numeric then raise exception 'invalid freight schedule allocation'; end if;
  elsif p_snapshot#>>'{freight,basis}'='order_schedule' then raise exception 'freight schedule missing'; end if;
  -- DATA-01 locks/checks successful expected revision and all cumulative quantities.
  v_part := claim_dispatch(p_org_id,p_source_id,p_dispatch_id,p_source_revision,'bill:'||p_dispatch_id::text);
  select count(*)+1 into v_index from invoice_calculation_snapshots s join dispatches sd on sd.id=s.dispatch_id
    where s.org_id=p_org_id and s.source_id=p_source_id and sd.order_key=d.order_key;
  v_number:=g.number_base||billing_suffix(v_index);
  insert into invoices(org_id,account_id,invoice_number,state,currency,subtotal_cents,tax_cents,total_cents,due_at)
    values(p_org_id,v_account,v_number,'draft',p_snapshot->>'currency',v_subtotal+v_freight,v_tax,v_total,
      (p_snapshot#>>'{terms,dueDate}')::date::timestamp at time zone (p_snapshot->>'timezone')) returning id into v_invoice;
  insert into invoice_lines(org_id,invoice_id,product_id,description,quantity,unit_price_cents,total_cents)
    select p_org_id,v_invoice,(x->>'productId')::uuid,x->>'description',(x->>'dispatched')::int,(x->>'unitPrice')::bigint,(x->>'lineAmount')::bigint from jsonb_array_elements(p_snapshot->'lines') x;
  if v_freight>0 then insert into invoice_lines(org_id,invoice_id,description,quantity,unit_price_cents,total_cents)
    values(p_org_id,v_invoice,'Freight',1,v_freight,v_freight); end if;
  v_document:=jsonb_build_object('schemaVersion',1,'company_id',p_org_id,'invoiceId',v_invoice,'revision',1,
    'invoiceNumber',v_number,'orderReference',p_order_reference,'calculation',p_snapshot);
  v_hash:=encode(digest(v_document::text,'sha256'),'hex');
  insert into invoice_calculation_snapshots(id,org_id,invoice_id,part_id,source_id,dispatch_id,source_revision,pricing_version_id,snapshot,content_hash,document)
    values(v_snapshot_id,p_org_id,v_invoice,v_part,p_source_id,p_dispatch_id,p_source_revision,p_pricing_version_id,p_snapshot,v_hash,v_document);
  v_event:=jsonb_build_object('event_id','invoice-drafted:'||v_invoice,'event_type','controller.invoice.drafted','event_version',1,
    'company_id',p_org_id,'connection_id',p_source_id,'occurred_at',now(),'observed_at',now(),'producer','controller',
    'subject_type','Invoice','subject_id',v_invoice,'subject_version',1,'correlation_id',v_part,'causation_id',null,
    'source_refs',jsonb_build_array(jsonb_build_object('company_id',p_org_id,'type','Dispatch','id',p_dispatch_id)),
    'evidence_refs',jsonb_build_array(jsonb_build_object('company_id',p_org_id,'type','InvoiceCalculationSnapshot','id',v_snapshot_id,'revision',1)),
    'event_class','fact','payload',jsonb_build_object('company_id',p_org_id,'invoice_id',v_invoice,'invoice_revision',1,
      'dispatch_id',p_dispatch_id,'part_id',v_part,
      'calculation_snapshot_ref',jsonb_build_object('company_id',p_org_id,'type','InvoiceCalculationSnapshot','id',v_snapshot_id,'revision',1),
      'document_snapshot_ref',jsonb_build_object('company_id',p_org_id,'type','InvoiceDocumentSnapshot','id',v_snapshot_id,'revision',1),
      'total',jsonb_build_object('amount_minor',v_total::text,'currency',p_snapshot->>'currency','scale',2)));
  perform publish_platform_event(p_org_id,v_event,'invoice-drafted:'||v_invoice,array['controller.invoice-drafts']);
  return jsonb_build_object('invoiceId',v_invoice,'snapshotId',v_snapshot_id,'reused',false);
end $$;

-- Issuance/settlement may change lifecycle fields, never accepted BILL content.
create function protect_billing_snapshot() returns trigger language plpgsql set search_path=pg_catalog,public as $$
begin
  if TG_TABLE_NAME='invoices' then
    if exists(select 1 from invoice_calculation_snapshots where invoice_id=old.id) and
      (TG_OP='DELETE' or (to_jsonb(new)-array['state','issued_at','paid_at','updated_at','stripe_invoice_id']) is distinct from
       (to_jsonb(old)-array['state','issued_at','paid_at','updated_at','stripe_invoice_id'])) then raise exception 'invoice snapshot content is immutable'; end if;
  elsif exists(select 1 from invoice_calculation_snapshots where invoice_id=case when TG_OP='INSERT' then new.invoice_id else old.invoice_id end)
    or (TG_OP='UPDATE' and exists(select 1 from invoice_calculation_snapshots where invoice_id=new.invoice_id)) then raise exception 'snapshot invoice lines are immutable'; end if;
  if TG_OP='DELETE' then return old; end if; return new;
end $$;
create trigger protect_billing_invoice before update or delete on invoices for each row execute function protect_billing_snapshot();
create trigger protect_billing_lines before insert or update or delete on invoice_lines for each row execute function protect_billing_snapshot();

do $$ declare t text;r text;f regprocedure; begin
  foreach t in array array['billing_order_groups','invoice_calculation_snapshots'] loop
    execute format('alter table %I enable row level security',t); execute format('revoke all on table %I from public',t);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on table %I from %I',t,r);
        if r='service_role' then execute format('grant select on table %I to service_role',t); end if;
      end if;
    end loop;
  end loop;
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in ('draft_dispatch_invoice','protect_billing_snapshot','billing_suffix') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
