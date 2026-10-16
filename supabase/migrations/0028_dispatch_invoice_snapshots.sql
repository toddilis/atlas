-- BILL-01 consumes DATA-01 allocation; EVENT-01 publish_platform_event is a runtime
-- prerequisite. Missing publication rolls the complete transaction back.
create table billing_order_groups (
  org_id uuid not null references orgs(id), source_id uuid not null, order_key text not null,
  number_base text not null, order_reference text not null, account_id uuid not null references accounts(id),
  created_at timestamptz not null default now(),
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
-- Carrier cost for one shipment, recorded by the configured carrier adapter (GoSweetSpot for
-- VICE). A draft can use only the latest record for its own dispatch, never a typed-in cost.
create table carrier_cost_evidence (
  id uuid primary key default gen_random_uuid(), org_id uuid not null references orgs(id),
  source_id uuid not null, dispatch_id uuid not null,
  carrier_connection text not null check(length(carrier_connection)>0), quote_key text not null check(length(quote_key)>0),
  currency text not null check(currency ~ '^[A-Z]{3}$'), tax_basis text not null check(tax_basis='exclusive'),
  cost_minor bigint not null check(cost_minor>=0),
  observed_at timestamptz not null, expires_at timestamptz not null check(expires_at>observed_at),
  evidence jsonb not null check(jsonb_typeof(evidence)='object'), recorded_at timestamptz not null default now(),
  foreign key(org_id,source_id,dispatch_id) references dispatches(org_id,source_id,id),
  unique(org_id,carrier_connection,quote_key)
);
create index carrier_cost_evidence_dispatch on carrier_cost_evidence(org_id,dispatch_id,observed_at desc,recorded_at desc);
create trigger invoice_calculations_immutable before update or delete on invoice_calculation_snapshots
  for each row execute function reject_dispatch_history_mutation();
create trigger billing_order_groups_immutable before update or delete on billing_order_groups
  for each row execute function reject_dispatch_history_mutation();
create trigger carrier_cost_evidence_immutable before update or delete on carrier_cost_evidence
  for each row execute function reject_dispatch_history_mutation();

create function billing_suffix(p_index integer) returns text language plpgsql immutable as $$
declare v integer := p_index; s text := ''; begin
  if v < 1 then raise exception 'positive part index required'; end if;
  while v > 0 loop v:=v-1; s:=chr(65+v%26)||s; v:=v/26; end loop; return s;
end $$;

-- Service-only writer for the carrier adapter. Replaying the same provider record is a no-op;
-- different content under the same quote is a correction, not a retry.
create function record_carrier_cost(p_org_id uuid,p_source_id uuid,p_dispatch_id uuid,p_carrier_connection text,p_quote_key text,
  p_currency text,p_cost_minor bigint,p_observed_at timestamptz,p_expires_at timestamptz,p_evidence jsonb)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare v carrier_cost_evidence%rowtype; v_id uuid;
begin
  if not exists(select 1 from dispatches where org_id=p_org_id and source_id=p_source_id and id=p_dispatch_id) then
    raise exception 'dispatch unavailable to business/source'; end if;
  if p_observed_at is null or p_observed_at>clock_timestamp() then raise exception 'carrier evidence cannot be observed in the future'; end if;
  insert into carrier_cost_evidence(org_id,source_id,dispatch_id,carrier_connection,quote_key,currency,tax_basis,cost_minor,observed_at,expires_at,evidence)
    values(p_org_id,p_source_id,p_dispatch_id,p_carrier_connection,p_quote_key,p_currency,'exclusive',p_cost_minor,p_observed_at,p_expires_at,p_evidence)
    on conflict (org_id,carrier_connection,quote_key) do nothing returning id into v_id;
  if v_id is not null then return v_id; end if;
  select * into v from carrier_cost_evidence where org_id=p_org_id and carrier_connection=p_carrier_connection and quote_key=p_quote_key;
  if v.source_id<>p_source_id or v.dispatch_id<>p_dispatch_id or v.currency<>p_currency or v.cost_minor<>p_cost_minor
    or v.observed_at<>p_observed_at or v.expires_at<>p_expires_at or v.evidence<>p_evidence then
    raise exception 'carrier evidence replay conflicts with the stored record'; end if;
  return v.id;
end $$;

-- Independent storage-boundary calculation verification. Never trust a caller's
-- internally consistent total as evidence that configured rules were followed.
create function assert_pricing_snapshot(c jsonb,s jsonb) returns void
language plpgsql set search_path=pg_catalog,public as $$
declare
  i jsonb:=s->'input'; b jsonb; l jsonb; r jsonb; selected jsonb; tier jsonb; negotiated jsonb; rules jsonb;
  k text; chosen text; unit numeric; base numeric; reduction numeric; freight numeric:=0; subtotal numeric:=0;
  undiscounted numeric:=0; value numeric; rate numeric; n integer; highest integer; basis integer; later boolean:=false;
  carrier jsonb:=nullif(i->'carrier','null'); shipping jsonb; threshold jsonb; due date; anchor timestamptz;
begin
  -- Exact shapes: nothing unverified rides along into the immutable snapshot.
  if jsonb_typeof(s) is distinct from 'object' or jsonb_typeof(i) is distinct from 'object'
    or s-array['schemaVersion','businessId','configVersion','currency','scale','taxBasis','pricingAt','pricingDateBasis','timezone',
      'rounding','input','lines','freight','tax','subtotal','total','terms']<>'{}'::jsonb or (select count(*) from jsonb_object_keys(s))<>17
    or i-array['businessId','accountId','orderKey','dispatchKey','orderAt','dispatchAt','evaluatedAt','destination','lines','carrier',
      'freightOverride','priorParts','taxExempt','orderValue','terms']<>'{}'::jsonb or (select count(*) from jsonb_object_keys(i))<>15
    or (s->'freight')-array['amount','carrier','ruleId','basis','override','explanation']<>'{}'::jsonb or (select count(*) from jsonb_object_keys(s->'freight'))<>6
    or (s->'tax')-array['rateBps','exempt','freightTaxable','amount']<>'{}'::jsonb or (select count(*) from jsonb_object_keys(s->'tax'))<>4
    or (carrier is not null and (carrier-array['businessId','connectionId','shipmentKey','quoteId','observedAt','expiresAt','currency','taxBasis','cost']<>'{}'::jsonb
      or (select count(*) from jsonb_object_keys(carrier))<>9))
    or jsonb_typeof(i->'priorParts') is distinct from 'number' or (i->>'priorParts')::numeric<0 or (i->>'priorParts')::numeric<>floor((i->>'priorParts')::numeric)
    or jsonb_typeof(i->'taxExempt') is distinct from 'boolean'
    then raise exception 'snapshot shape mismatch'; end if;
  if s->>'schemaVersion' is distinct from '1' or s->>'scale' is distinct from c->>'scale'
    or s->>'taxBasis' is distinct from 'exclusive' or c->>'taxBasis' is distinct from 'exclusive'
    or s->>'pricingDateBasis' is distinct from c->>'pricingDateBasis'
    or s->>'rounding' is distinct from 'floor_minor_unit_per_discount_then_invoice_tax'
    or (s->>'pricingAt')::timestamptz is distinct from
      (case when c->>'pricingDateBasis'='order' then i->>'orderAt' else i->>'dispatchAt' end)::timestamptz
    then raise exception 'snapshot calculation contract mismatch'; end if;
  -- A tax-exempt retailer (export / zero-rated) is charged no tax; the draft checks the flag.
  rate:=case when (i->>'taxExempt')::boolean then 0 else (c->>'taxRateBps')::numeric end;
  if (s#>>'{tax,rateBps}')::numeric is distinct from rate or s#>'{tax,exempt}' is distinct from i->'taxExempt'
    or s#>'{tax,freightTaxable}' is distinct from c->'freightTaxable' then raise exception 'snapshot tax treatment mismatch'; end if;
  select x into r from jsonb_array_elements(c->'bindings') x where x->>'accountId'=i->>'accountId';
  if found then select x into b from jsonb_array_elements(c->'books') x where x->>'id'=r->>'bookId';
  elsif c->>'fallback'='default_book' then select x into b from jsonb_array_elements(c->'books') x where (x->>'isDefault')::boolean; end if;
  if b is null then raise exception 'snapshot retailer binding missing'; end if;
  if jsonb_array_length(i->'lines') is distinct from jsonb_array_length(s->'lines') then raise exception 'snapshot/input line mismatch'; end if;
  for l in select x from jsonb_array_elements(s->'lines') x loop
    if l-array['lineId','productId','description','ordered','dispatched','override','bookId','baseUnitPrice','selectedRule','selectedKind',
      'beforeDiscountUnitPrice','beforeOverrideUnitPrice','discountPerUnit','overrideDelta','discountRules','unitPrice','lineAmount','explanation']<>'{}'::jsonb
      or (select count(*) from jsonb_object_keys(l))<>18 then raise exception 'snapshot shape mismatch'; end if;
    if not exists(select 1 from jsonb_array_elements(i->'lines') x where x->>'lineId'=l->>'lineId'
      and x->>'productId'=l->>'productId' and x->>'ordered'=l->>'ordered' and x->>'dispatched'=l->>'dispatched'
      and x->>'description'=l->>'description' and x->'override' is not distinct from l->'override'
      and (select count(*) from jsonb_object_keys(x))=6) then raise exception 'snapshot/input line mismatch'; end if;
    select x into selected from jsonb_array_elements(b->'entries') x where x->>'productId'=l->>'productId';
    if not found then raise exception 'configured product price missing'; end if;
    base:=(selected->>'unitPrice')::numeric;
    -- A retailer-specific rule outranks a general (accountId null) rule for the same product.
    select count(*),jsonb_agg(x) into n,rules from jsonb_array_elements(c->'negotiated') x
      where x->>'productId'=l->>'productId' and x->>'accountId'=i->>'accountId';
    if n=0 then select count(*),jsonb_agg(x) into n,rules from jsonb_array_elements(c->'negotiated') x
      where x->>'productId'=l->>'productId' and x->>'accountId' is null; end if;
    if n>1 then raise exception 'conflicting negotiated prices'; end if; negotiated:=rules->0;
    basis:=(case when c->>'tierQuantityBasis'='ordered' then l->>'ordered' else l->>'dispatched' end)::integer;
    select max((x->>'minimum')::integer) into highest from jsonb_array_elements(c->'tiers') x
      where x->>'productId'=l->>'productId' and x->>'accountId'=i->>'accountId' and (x->>'minimum')::integer<=basis;
    if highest is not null then
      select count(*),jsonb_agg(x) into n,rules from jsonb_array_elements(c->'tiers') x
        where x->>'productId'=l->>'productId' and x->>'accountId'=i->>'accountId' and (x->>'minimum')::integer=highest;
    else
      select max((x->>'minimum')::integer) into highest from jsonb_array_elements(c->'tiers') x
        where x->>'productId'=l->>'productId' and x->>'accountId' is null and (x->>'minimum')::integer<=basis;
      select count(*),jsonb_agg(x) into n,rules from jsonb_array_elements(c->'tiers') x
        where x->>'productId'=l->>'productId' and x->>'accountId' is null and (x->>'minimum')::integer=highest;
    end if;
    if n>1 then raise exception 'conflicting quantity tiers'; end if; tier:=rules->0;
    chosen:=null;
    for k in select jsonb_array_elements_text(c->'pricePrecedence') loop
      if k='negotiated' and negotiated is not null then selected:=negotiated;chosen:=k;exit;
      elsif k='tier' and tier is not null then selected:=tier;chosen:=k;exit;
      elsif k='book' then selected:=jsonb_build_object('id',b->>'id','unitPrice',base::text);chosen:=k;exit; end if;
    end loop;
    if chosen is null then raise exception 'configured price precedence missing'; end if;
    unit:=(selected->>'unitPrice')::numeric;
    if l->>'bookId' is distinct from b->>'id' or l->>'selectedRule' is distinct from selected->>'id'
      or l->>'selectedKind' is distinct from chosen or (l->>'baseUnitPrice')::numeric is distinct from base
      or (l->>'beforeDiscountUnitPrice')::numeric is distinct from unit then raise exception 'configured price selection mismatch'; end if;
    undiscounted:=undiscounted+unit*(l->>'dispatched')::integer;
    -- Single: the retailer's own discount if it has one, otherwise the general one.
    -- Sequential: every configured discount in order.
    select coalesce(jsonb_agg(x order by (x->>'order')::integer),'[]') into rules from jsonb_array_elements(c->'discounts') x
      where x->>'productId'=l->>'productId' and (x->>'accountId'=i->>'accountId' or (x->>'accountId' is null and (c->>'discountCombination'='sequential'
        or not exists(select 1 from jsonb_array_elements(c->'discounts') y where y->>'productId'=l->>'productId' and y->>'accountId'=i->>'accountId'))));
    if jsonb_array_length(rules)>1 and (c->>'discountCombination'='single' or
      (select count(distinct x->>'order') from jsonb_array_elements(rules) x)<>jsonb_array_length(rules)) then raise exception 'conflicting discounts'; end if;
    if chosen<>'book' and not (c->>'discountOnSpecialPrice')::boolean then rules:='[]'; end if;
    if l->'discountRules' is distinct from (select coalesce(jsonb_agg(x->>'id'),'[]') from jsonb_array_elements(rules) x) then raise exception 'discount explanation mismatch'; end if;
    for r in select x from jsonb_array_elements(rules) x loop
      reduction:=case when r#>>'{discount,kind}'='fixed' then (r#>>'{discount,amount}')::numeric else floor(unit*(r#>>'{discount,bps}')::numeric/10000) end;
      if reduction>unit or reduction<0 then raise exception 'invalid configured discount'; end if; unit:=unit-reduction;
    end loop;
    -- Persisted exceptions wait for the protected override action seam; preview can
    -- explain them, but a raw service RPC cannot invent an authenticated actor.
    if nullif(l->'override','null') is not null then raise exception 'persisted override requires protected exception service'; end if;
    if (l->>'unitPrice')::numeric is distinct from unit or (l->>'beforeOverrideUnitPrice')::numeric is distinct from unit
      or (l->>'discountPerUnit')::numeric is distinct from (l->>'beforeDiscountUnitPrice')::numeric-unit
      or l->>'overrideDelta' is distinct from '0' then raise exception 'configured unit price mismatch'; end if;
    subtotal:=subtotal+unit*(l->>'dispatched')::integer;
  end loop;
  -- Dispatches carry no authoritative destination, so an unverified claim may neither
  -- select a destination rule nor be stored as fact; never infer an address zone.
  if nullif(i->'destination','null') is not null or ((c#>>'{shipping,enabled}')::boolean and exists(
    select 1 from jsonb_array_elements(c#>'{shipping,rules}') x where nullif(x->'destination','null') is not null
      and (x->>'accountId' is null or x->>'accountId'=i->>'accountId')))
    then raise exception 'destination freight requires authoritative dispatch destination'; end if;
  if (c#>>'{shipping,enabled}')::boolean then
    select max((x->>'priority')::integer) into highest from jsonb_array_elements(c#>'{shipping,rules}') x
      where (x->>'accountId' is null or x->>'accountId'=i->>'accountId') and (x->>'destination' is null or x->>'destination'=i->>'destination');
    select count(*),jsonb_agg(x) into n,rules from jsonb_array_elements(c#>'{shipping,rules}') x
      where (x->>'accountId' is null or x->>'accountId'=i->>'accountId') and (x->>'destination' is null or x->>'destination'=i->>'destination') and (x->>'priority')::integer=highest;
    if n<>1 then raise exception 'missing or conflicting shipping rules'; end if; shipping:=rules->0;
    if shipping->>'chargingBasis' not in ('per_dispatch','first_part') then raise exception 'unsupported freight charging basis'; end if;
    if s#>>'{freight,ruleId}' is distinct from shipping->>'id' or s#>>'{freight,basis}' is distinct from shipping->>'chargingBasis'
      or s#>'{freight,carrier}' is distinct from i->'carrier' then raise exception 'freight binding mismatch'; end if;
    -- The draft matches any quote against stored carrier evidence for its dispatch.
    if carrier is not null and (carrier->>'businessId' is distinct from s->>'businessId' or carrier->>'shipmentKey' is distinct from i->>'dispatchKey'
      or carrier->>'currency' is distinct from c->>'currency' or carrier->>'taxBasis' is distinct from 'exclusive') then raise exception 'carrier binding mismatch'; end if;
    if nullif(i->'freightOverride','null') is not null then raise exception 'persisted freight override requires protected exception service'; end if;
    k:=shipping#>>'{mode,kind}';
    -- first_part: only an order's first drafted part carries freight (VICE: PLAN D15).
    later:=shipping->>'chargingBasis'='first_part' and (i->>'priorParts')::integer>0;
    if later then freight:=0;
    else
      if k in ('actual','adjusted') then
        if carrier is null then raise exception 'carrier cost requires stored carrier evidence'; end if;
        freight:=(carrier->>'cost')::numeric;
        if k='adjusted' then freight:=freight+(shipping#>>'{mode,fixed}')::numeric+floor(freight*(shipping#>>'{mode,markupBps}')::numeric/10000); end if;
      elsif k='fixed' then freight:=(shipping#>>'{mode,amount}')::numeric;
      elsif k='free' then freight:=0;
      else raise exception 'persisted manual freight requires protected exception service'; end if;
      threshold:=nullif(shipping->'freeThreshold','null');
      if threshold is not null then
        if threshold->>'valueBasis'='order' then raise exception 'order threshold requires authoritative whole-order preview'; end if;
        value:=case when (threshold->>'afterDiscount')::boolean then subtotal else undiscounted end;
        if (threshold->>'includesTax')::boolean then value:=value+floor(value*rate/10000); end if;
        if value>=(threshold->>'amount')::numeric then freight:=0; end if;
      end if;
    end if;
  elsif s#>>'{freight,basis}' is distinct from 'disabled' or carrier is not null or nullif(i->'freightOverride','null') is not null then raise exception 'shipping disabled'; end if;
  if (s#>>'{freight,amount}')::numeric is distinct from freight then raise exception 'configured freight amount mismatch'; end if;
  if (s->>'subtotal')::numeric is distinct from subtotal
    or (s#>>'{tax,amount}')::numeric is distinct from floor((subtotal+case when (c->>'freightTaxable')::boolean then freight else 0 end)*rate/10000)
    or (s->>'total')::numeric is distinct from subtotal+freight+(s#>>'{tax,amount}')::numeric then raise exception 'snapshot total arithmetic mismatch'; end if;
  -- Standard terms are configuration. Owner-selected terms for one invoice wait for the
  -- protected exception seam, like overrides: an actor string here is not authentication.
  if i#>>'{terms,kind}'='explicit' then raise exception 'persisted explicit terms require protected exception service';
  elsif i#>>'{terms,kind}'='following_month_day' then
    if c#>>'{terms,kind}' is distinct from 'following_month_day' or coalesce((c#>>'{terms,day}')::integer,0) not between 1 and 28
      or coalesce(c#>>'{terms,anchor}','') not in ('invoice','dispatch') then raise exception 'configured payment terms missing'; end if;
    if i#>'{terms,day}' is distinct from c#>'{terms,day}' or i#>>'{terms,anchor}' is distinct from c#>>'{terms,anchor}'
      or (select count(*) from jsonb_object_keys(i->'terms'))<>4 then raise exception 'terms differ from configured standard terms'; end if;
    -- The draft is the invoice date: a caller cannot back- or forward-date the anchor month.
    if i#>>'{terms,anchor}'='invoice' and ((((i#>>'{terms,invoiceAt}')::timestamptz) at time zone (c->>'timezone'))::date
      is distinct from (now() at time zone (c->>'timezone'))::date or (i#>>'{terms,invoiceAt}')::timestamptz>clock_timestamp())
      then raise exception 'invoice-dated terms must use the draft date'; end if;
    anchor:=(case when i#>>'{terms,anchor}'='dispatch' then i->>'dispatchAt' when i#>>'{terms,anchor}'='invoice' then i#>>'{terms,invoiceAt}' else null end)::timestamptz;
    due:=(date_trunc('month',anchor at time zone (c->>'timezone'))+interval '1 month')::date+((i#>>'{terms,day}')::integer-1);
  else raise exception 'terms missing or unsupported'; end if;
  if due is null or s#>>'{terms,dueDate}' is distinct from to_char(due,'YYYY-MM-DD') or ((s->'terms')-'dueDate') is distinct from ((i->'terms')-'dueDate') then raise exception 'terms snapshot mismatch'; end if;
end $$;

create function draft_dispatch_invoice(p_org_id uuid,p_source_id uuid,p_dispatch_id uuid,p_source_revision timestamptz,
  p_pricing_version_id uuid,p_snapshot jsonb,p_order_reference text)
returns jsonb language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  d dispatches%rowtype; g billing_order_groups%rowtype; existing invoice_calculation_snapshots%rowtype;
  c pricing_versions%rowtype; o shopify_orders%rowtype; ev carrier_cost_evidence%rowtype; l jsonb; dl dispatch_lines%rowtype;
  v_part uuid; v_invoice uuid; v_snapshot_id uuid:=gen_random_uuid(); v_number text; v_prior integer;
  v_subtotal numeric:=0; v_freight bigint; v_tax bigint; v_total bigint; v_rate numeric; v_exempt boolean;
  v_document jsonb; v_hash text; v_account uuid; v_event jsonb;
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
  -- The billed retailer is the order's, never the caller's. A Shopify order names it through
  -- the linked customer; other sources need an order account contract before they can bill.
  if not exists(select 1 from dispatch_sources where org_id=p_org_id and id=p_source_id and provider='shopify') then
    raise exception 'order retailer contract required for this dispatch source'; end if;
  select * into o from shopify_orders where org_id=p_org_id and id::text=d.order_key;
  if not found then raise exception 'dispatch order unavailable'; end if;
  select account_id into v_account from shopify_customers where org_id=p_org_id and shopify_customer_id=o.shopify_customer_id;
  if v_account is null then raise exception 'order retailer unknown: link the Shopify customer to an account'; end if;
  if p_snapshot#>>'{input,accountId}' is distinct from v_account::text then raise exception 'snapshot account is not the order''s retailer'; end if;
  if o.currency is distinct from p_snapshot->>'currency' then raise exception 'order currency differs from pricing currency'; end if;
  select tax_exempt into v_exempt from accounts where org_id=p_org_id and id=v_account;
  if v_exempt is null then raise exception 'account unavailable to business'; end if;
  if p_snapshot#>'{input,taxExempt}' is distinct from to_jsonb(v_exempt) then raise exception 'snapshot tax treatment differs from the account'; end if;
  -- A fulfillment the legacy path has invoiced is not invoiced again here (and the legacy
  -- guard below refuses the reverse), both under this order lock.
  if exists(select 1 from shopify_fulfillments f join fulfillment_events e on e.org_id=p_org_id and e.shopify_fulfillment_id=f.id
    join invoices li on li.org_id=p_org_id and li.fulfillment_event_id=e.id and li.state<>'void'
    where f.org_id=p_org_id and f.shopify_fulfillment_id=d.source_dispatch_key) then
    raise exception 'fulfillment already has a legacy invoice; reconcile first'; end if;
  -- Parts are numbered, and first-part freight assigned, in drafting order under the order lock.
  select count(*) into v_prior from invoice_calculation_snapshots s join dispatches sd on sd.id=s.dispatch_id
    where s.org_id=p_org_id and s.source_id=p_source_id and sd.order_key=d.order_key;
  if p_snapshot#>'{input,priorParts}' is distinct from to_jsonb(v_prior) then raise exception 'stale part order; recalculate'; end if;
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
  if c.config->>'currency' is distinct from p_snapshot->>'currency' or c.config->>'timezone' is distinct from p_snapshot->>'timezone'
    then raise exception 'snapshot configuration mismatch'; end if;
  if d.source_occurred_at is null or (p_snapshot#>>'{input,dispatchAt}')::timestamptz is distinct from d.source_occurred_at then raise exception 'authoritative dispatch time required'; end if;
  if c.config->>'pricingDateBasis'='order' and (o.placed_at is null or o.placed_at is distinct from (p_snapshot#>>'{input,orderAt}')::timestamptz)
    then raise exception 'authoritative order time required'; end if;
  perform assert_pricing_snapshot(c.config,p_snapshot);
  -- A carrier quote must be the latest evidence stored for this dispatch, still valid.
  if nullif(p_snapshot#>'{input,carrier}','null'::jsonb) is not null then
    select * into ev from carrier_cost_evidence where org_id=p_org_id and dispatch_id=d.id order by observed_at desc,recorded_at desc limit 1;
    if not found or ev.carrier_connection is distinct from p_snapshot#>>'{input,carrier,connectionId}' or ev.quote_key is distinct from p_snapshot#>>'{input,carrier,quoteId}'
      or ev.cost_minor::text is distinct from p_snapshot#>>'{input,carrier,cost}' or ev.currency is distinct from p_snapshot#>>'{input,carrier,currency}'
      or ev.observed_at is distinct from (p_snapshot#>>'{input,carrier,observedAt}')::timestamptz
      or ev.expires_at is distinct from (p_snapshot#>>'{input,carrier,expiresAt}')::timestamptz then raise exception 'carrier cost requires stored carrier evidence'; end if;
    if ev.expires_at<=clock_timestamp() then raise exception 'stored carrier evidence expired'; end if;
  end if;
  if jsonb_typeof(p_snapshot->'lines') is distinct from 'array' or jsonb_array_length(p_snapshot->'lines')=0 then raise exception 'snapshot lines required'; end if;
  if (select count(*) from dispatch_lines where dispatch_id=d.id and active) <> jsonb_array_length(p_snapshot->'lines')
    or (select count(distinct value->>'lineId') from jsonb_array_elements(p_snapshot->'lines')) <> jsonb_array_length(p_snapshot->'lines') then raise exception 'snapshot must include each dispatch line exactly once'; end if;
  for l in select value from jsonb_array_elements(p_snapshot->'lines') loop
    select * into dl from dispatch_lines where dispatch_id=d.id and active and id::text=l->>'lineId';
    if not found or dl.quantity::text is distinct from l->>'dispatched' or dl.ordered_quantity::text is distinct from l->>'ordered'
      then raise exception 'snapshot dispatched quantity mismatch'; end if;
    if not exists(select 1 from products where org_id=p_org_id and id::text=l->>'productId' and sku=dl.item_key) then raise exception 'snapshot product mapping mismatch'; end if;
    if not exists(select 1 from products where org_id=p_org_id and id::text=l->>'productId' and display_name=l->>'description') then raise exception 'snapshot line description must be the product name'; end if;
    if coalesce(l->>'unitPrice','') !~ '^(0|[1-9][0-9]*)$' or coalesce(l->>'lineAmount','') !~ '^(0|[1-9][0-9]*)$'
      or (l->>'lineAmount')::numeric <> (l->>'unitPrice')::numeric * dl.quantity then raise exception 'snapshot line arithmetic mismatch'; end if;
    v_subtotal := v_subtotal+(l->>'lineAmount')::numeric;
  end loop;
  v_rate := case when v_exempt then 0 else (c.config->>'taxRateBps')::numeric end;
  v_freight := (p_snapshot#>>'{freight,amount}')::bigint;
  v_tax := (p_snapshot#>>'{tax,amount}')::bigint; v_total := (p_snapshot->>'total')::bigint;
  if v_freight is null or v_freight<0 or v_tax is null or v_tax<0 or v_total is null or v_total<0
    or v_subtotal is distinct from (p_snapshot->>'subtotal')::numeric
    or v_tax::numeric <> floor((v_subtotal+case when (c.config->>'freightTaxable')::boolean then v_freight else 0 end)*v_rate/10000)
    or v_total::numeric <> v_subtotal+v_freight+v_tax then raise exception 'snapshot total arithmetic mismatch'; end if;
  select * into g from billing_order_groups where org_id=p_org_id and source_id=p_source_id and order_key=d.order_key;
  if found then
    if g.account_id<>v_account or g.order_reference<>p_order_reference then raise exception 'order billing changed; correction required'; end if;
  else
    insert into billing_order_groups(org_id,source_id,order_key,number_base,order_reference,account_id)
      values(p_org_id,p_source_id,d.order_key,next_invoice_number(p_org_id),p_order_reference,v_account) returning * into g;
  end if;
  -- DATA-01 locks/checks successful expected revision and all cumulative quantities.
  v_part := claim_dispatch(p_org_id,p_source_id,p_dispatch_id,p_source_revision,'bill:'||p_dispatch_id::text);
  v_number:=g.number_base||billing_suffix(v_prior+1);
  insert into invoices(org_id,account_id,invoice_number,state,currency,subtotal_cents,tax_cents,total_cents,due_at)
    values(p_org_id,v_account,v_number,'draft',p_snapshot->>'currency',v_subtotal+v_freight,v_tax,v_total,
      (p_snapshot#>>'{terms,dueDate}')::date::timestamp at time zone (p_snapshot->>'timezone')) returning id into v_invoice;
  insert into invoice_lines(org_id,invoice_id,product_id,description,quantity,unit_price_cents,total_cents)
    select p_org_id,v_invoice,(x->>'productId')::uuid,x->>'description',(x->>'dispatched')::int,(x->>'unitPrice')::bigint,(x->>'lineAmount')::bigint from jsonb_array_elements(p_snapshot->'lines') x;
  if v_freight>0 then insert into invoice_lines(org_id,invoice_id,description,quantity,unit_price_cents,total_cents)
    values(p_org_id,v_invoice,'Freight',1,v_freight,v_freight); end if;
  v_document:=jsonb_build_object('schemaVersion',1,'company_id',p_org_id,'invoiceId',v_invoice,'revision',1,
    'invoiceNumber',v_number,'orderReference',p_order_reference,'calculation',p_snapshot);
  v_hash:=encode(sha256(convert_to(v_document::text,'UTF8')),'hex');
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
      'total',jsonb_build_object('amount_minor',v_total::text,'currency',p_snapshot->>'currency','scale',(p_snapshot->>'scale')::integer)));
  -- No consumer receipts until something projects drafted invoices (none does yet);
  -- a future consumer backfills with enqueue_event_replay.
  perform publish_platform_event(p_org_id,v_event,'invoice-drafted:'||v_invoice,'{}');
  return jsonb_build_object('invoiceId',v_invoice,'snapshotId',v_snapshot_id,'reused',false);
end $$;

-- Legacy draft_invoice_atomic invoices one Shopify fulfillment. Refuse it when BILL has
-- already claimed that fulfillment's dispatch. A try-lock fails fast instead of waiting
-- on a BILL draft of the same order while holding the invoice counter (no deadlock).
create function guard_legacy_fulfillment_invoice() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare e fulfillment_events%rowtype; v_fulfillment text; v_source uuid;
begin
  if new.fulfillment_event_id is null then return new; end if;
  select * into e from fulfillment_events where id=new.fulfillment_event_id;
  select shopify_fulfillment_id into v_fulfillment from shopify_fulfillments where id=e.shopify_fulfillment_id;
  select id into v_source from dispatch_sources where org_id=new.org_id and provider='shopify';
  if v_source is null then return new; end if;
  if not pg_try_advisory_xact_lock(hashtextextended(v_source::text||':'||e.shopify_order_id::text,0)) then
    raise exception 'order is being invoiced by BILL; retry'; end if;
  if exists(select 1 from dispatches d join dispatch_invoice_parts p on p.dispatch_id=d.id
    where d.org_id=new.org_id and d.source_id=v_source and d.source_dispatch_key=v_fulfillment) then
    raise exception 'fulfillment already invoiced by BILL; reconcile first'; end if;
  return new;
end $$;
create trigger legacy_fulfillment_invoice_guard before insert on invoices for each row execute function guard_legacy_fulfillment_invoice();

-- Issuance/settlement may change lifecycle fields, never accepted BILL content.
create function protect_billing_snapshot() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
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

-- BILL owns controller.invoice.drafted; EVENT-01 (0025) leaves it unprojected until this
-- validator exists. Every publisher, SQL or TS, must match InvoiceDraftedV1 and name this
-- business's real invoice, part, dispatch and calculation snapshot.
create function validate_invoice_drafted_event() returns trigger language plpgsql security definer set search_path=pg_catalog,public as $$
declare p jsonb:=new.envelope->'payload'; k text;
begin
  if new.event_type<>'controller.invoice.drafted' or new.envelope->>'event_version'<>'1' then return new; end if;
  if jsonb_typeof(p) is distinct from 'object' or (select count(*) from jsonb_object_keys(p))<>8
  or not (p ?& array['company_id','invoice_id','invoice_revision','dispatch_id','part_id','calculation_snapshot_ref','document_snapshot_ref','total'])
  or p->>'company_id' is distinct from new.org_id::text
  or jsonb_typeof(p->'invoice_revision') is distinct from 'number' or (p->>'invoice_revision')!~'^[1-9][0-9]*$'
  or new.envelope->>'subject_type'<>'Invoice' or new.envelope->>'subject_id' is distinct from p->>'invoice_id'
  or new.envelope->>'subject_version' is distinct from p->>'invoice_revision' or new.envelope->>'event_class'<>'fact'
  or jsonb_typeof(p->'total') is distinct from 'object' or (select count(*) from jsonb_object_keys(p->'total'))<>3
  or coalesce(p#>>'{total,amount_minor}','')!~'^(0|[1-9][0-9]*)$' or coalesce(p#>>'{total,currency}','')!~'^[A-Z]{3}$'
  or jsonb_typeof(p#>'{total,scale}') is distinct from 'number' or (p#>>'{total,scale}')!~'^[0-6]$'
  then raise exception 'invalid controller.invoice.drafted payload'; end if;
  foreach k in array array['calculation_snapshot_ref','document_snapshot_ref'] loop
    if jsonb_typeof(p->k) is distinct from 'object' or (select count(*) from jsonb_object_keys(p->k))<>4
    or p#>>array[k,'company_id'] is distinct from new.org_id::text or p#>'{invoice_revision}' is distinct from p#>array[k,'revision']
    or p#>>array[k,'type'] is distinct from (case k when 'calculation_snapshot_ref' then 'InvoiceCalculationSnapshot' else 'InvoiceDocumentSnapshot' end)
    then raise exception 'invalid controller.invoice.drafted snapshot reference'; end if;
  end loop;
  if not exists(select 1 from invoice_calculation_snapshots c join invoices i on i.org_id=c.org_id and i.id=c.invoice_id
    where c.org_id=new.org_id and c.id::text=p#>>'{calculation_snapshot_ref,id}' and c.id::text=p#>>'{document_snapshot_ref,id}'
    and c.invoice_id::text=p->>'invoice_id' and c.part_id::text=p->>'part_id' and c.dispatch_id::text=p->>'dispatch_id'
    and c.revision=(p->>'invoice_revision')::integer and i.total_cents::text=p#>>'{total,amount_minor}' and i.currency=p#>>'{total,currency}')
  then raise exception 'controller.invoice.drafted does not match a stored invoice snapshot'; end if;
  return new;
end $$;
create trigger platform_invoice_drafted_validation before insert on platform_events for each row execute function validate_invoice_drafted_event();
create or replace function supported_platform_event(p_envelope jsonb) returns boolean language sql immutable as $$
 select p_envelope->>'event_version'='1' and p_envelope->>'event_type' in (
 'controller.decision.proposed','controller.action.execution_recorded','controller.outcome.recorded','controller.invoice.drafted',
 'platform.action.state_recorded','platform.approval.state_recorded','platform.attempt.state_recorded')
$$;

do $$ declare t text;r text;f regprocedure; begin
  foreach t in array array['billing_order_groups','invoice_calculation_snapshots','carrier_cost_evidence'] loop
    execute format('alter table %I enable row level security',t); execute format('revoke all on table %I from public',t);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on table %I from %I',t,r);
        if r='service_role' then execute format('grant select on table %I to service_role',t); end if;
      end if;
    end loop;
  end loop;
  -- draft_invoice_atomic kept the default PUBLIC grant; like every money RPC it is service-only.
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace and proname in ('draft_dispatch_invoice',
    'protect_billing_snapshot','billing_suffix','assert_pricing_snapshot','record_carrier_cost','guard_legacy_fulfillment_invoice','draft_invoice_atomic',
    'validate_invoice_drafted_event') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
