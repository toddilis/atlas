-- PORT-01: a second, deliberately contrasting synthetic business (USD, New York,
-- 8.75% tax that skips freight, order-date pricing, dispatched-quantity tiers, a
-- bindingless default book, tier-first precedence, sequential discounts on special
-- prices, per-dispatch freight with a value threshold, terms on the 1st) runs the same
-- catalogue → pricing → draft → issue → statement path the VICE-shaped fixture used
-- earlier in this database, with no business-specific code. Fixtures come from
-- scripts/portability-fixtures.ts; this file never hand-computes a price.
create function pg_temp.port_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT PORT: %',msg; end if; end $$;
create function pg_temp.port_reject(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like pattern then raise; end if; return; end;
  raise exception 'ASSERT PORT expected rejection: %',pattern;
end $$;
create function pg_temp.effects(company uuid) returns text language sql as $$
  select (select count(*) from dispatch_invoice_parts where org_id=company)||'/'||(select count(*) from dispatch_allocations where org_id=company)
    ||'/'||(select count(*) from billing_order_groups where org_id=company)||'/'||(select count(*) from invoices where org_id=company)
    ||'/'||(select count(*) from invoice_calculation_snapshots where org_id=company)||'/'||(select count(*) from platform_events where org_id=company) $$;
create function pg_temp.draft(company uuid,dispatch uuid,version uuid,snapshot jsonb,reference text) returns jsonb language plpgsql as $$
declare d dispatches%rowtype; r jsonb;
begin
  select * into d from dispatches where id=dispatch;
  execute 'set local role service_role';
  r:=draft_dispatch_invoice(company,d.source_id,dispatch,d.source_revision,version,snapshot,reference);
  execute 'reset role';
  return r;
end $$;
create function pg_temp.draft_refused(company uuid,dispatch uuid,version uuid,snapshot jsonb,pattern text) returns void language plpgsql as $$
declare d dispatches%rowtype; before text:=pg_temp.effects(company); reference text;
begin
  select * into d from dispatches where id=dispatch;
  select shopify_order_name into reference from shopify_orders where org_id=company and id::text=d.order_key;
  execute 'set local role service_role';
  perform pg_temp.port_reject(format('select draft_dispatch_invoice(%L,%L,%L,%L,%L,%L,%L)',
    company,d.source_id,dispatch,d.source_revision,version,snapshot,reference),pattern);
  execute 'reset role';
  perform pg_temp.port_assert(pg_temp.effects(company)=before,'refused draft left an effect: '||pattern);
end $$;
create function pg_temp.bind(snapshot jsonb,dispatch uuid) returns jsonb language sql as $$
  select jsonb_set(jsonb_set(snapshot,'{lines,0,lineId}',to_jsonb(l.id::text)),'{input,lines,0,lineId}',to_jsonb(l.id::text))
  from dispatch_lines l where l.dispatch_id=dispatch $$;
do $$
declare
  company uuid:=current_setting('test.port_company'); account uuid:=current_setting('test.port_account');
  product uuid:=current_setting('test.port_product'); order1 uuid:=current_setting('test.port_order_1');
  order2 uuid:=current_setting('test.port_order_2'); c jsonb:=current_setting('test.port_config')::jsonb;
  a jsonb:=current_setting('test.port_a')::jsonb; b jsonb:=current_setting('test.port_b')::jsonb;
  late_v1 jsonb:=current_setting('test.port_late_v1')::jsonb; late_v2 jsonb:=current_setting('test.port_late_v2')::jsonb;
  operator uuid:='75000000-0000-4000-8000-0000000000aa';
  -- The VICE-shaped fixture business probed earlier in this same database.
  vice uuid:='63000000-0000-4000-8000-000000000001';
  version_id uuid; next_version uuid; source uuid; dp1 uuid; dp2 uuid; dp3 uuid;
  ra jsonb; rb jsonb; rc jsonb; sha_a text; res jsonb; stmt record;
  lines jsonb:='[{"source_line_key":"p1","order_line_key":"ol-1","item_key":"GADGET","quantity":30,"ordered_quantity":50}]';
begin
  insert into orgs(id,slug,display_name,base_currency) values(company,'port-fixture','Synthetic imports (US)','USD');
  insert into accounts(id,org_id,name,currency) values(account,company,'Synthetic importer','USD');
  insert into products(id,org_id,sku,display_name) values(product,company,'GADGET','Synthetic gadget');
  insert into shopify_customers(org_id,shopify_customer_id,raw,account_id) values(company,'cust-imp','{}',account);
  insert into shopify_orders(id,org_id,shopify_order_id,shopify_order_name,shopify_customer_id,currency,subtotal_cents,total_cents,raw,placed_at) values
    (order1,company,'7100','#port-100','cust-imp','USD',0,0,'{}','2026-10-20T09:00:00-04:00'),
    (order2,company,'7200','#port-200','cust-imp','USD',0,0,'{}','2026-10-22T09:00:00-04:00');
  version_id:=save_pricing_version(company,0,c,'fixture-operator','Contrast initial version');
  perform activate_pricing_version(company,version_id,1,'fixture-operator','Contrast activation');
  next_version:=save_pricing_version(company,1,current_setting('test.port_config_v2')::jsonb,'fixture-operator','Contrast price change');
  perform activate_pricing_version(company,next_version,2,'fixture-operator','Contrast price change');
  -- The SQL recomputation accepts the TS calculator's snapshots for this shape too:
  -- tier over negotiated, stacked discounts on a special price, a waived and a charged
  -- per-dispatch freight, untaxed freight, and 1st-of-month New York terms.
  perform assert_pricing_snapshot(c,a); perform assert_pricing_snapshot(c,b);
  perform assert_pricing_snapshot(current_setting('test.port_config_v2')::jsonb,late_v2);

  source:=bind_shopify_dispatch_source(company,'port-fixture.myshopify.com');
  dp1:=project_dispatch(company,source,'dispatch-p1',order1::text,'2026-10-22T10:00:00-04:00','succeeded',null,lines,null,'{}','2026-10-22T10:00:00-04:00');
  dp2:=project_dispatch(company,source,'dispatch-p2',order1::text,'2026-10-24T10:00:00-04:00','succeeded',null,
    jsonb_set(lines,'{0,quantity}','20'),null,'{}','2026-10-24T10:00:00-04:00');
  a:=pg_temp.bind(a,dp1); b:=pg_temp.bind(b,dp2);
  -- Both shipments left after the 21 Oct price change, but the order was placed on the
  -- 20th: under pricingDateBasis 'order' v1 is the version in force for them and v2 is
  -- refused — the mirror of the VICE probe, where dispatch-date basis demands v2.
  perform pg_temp.draft_refused(company,dp1,next_version,a,'%stale or inactive pricing snapshot%');
  ra:=pg_temp.draft(company,dp1,version_id,a,'#port-100');
  rb:=pg_temp.draft(company,dp2,version_id,b,'#port-100');
  -- Order 2 was placed on the 22nd: v1 is stale for it, v2 prices it.
  dp3:=project_dispatch(company,source,'dispatch-p3',order2::text,'2026-10-23T10:00:00-04:00','succeeded',null,
    jsonb_set(jsonb_set(lines,'{0,quantity}','25'),'{0,ordered_quantity}','25'),null,'{}','2026-10-23T10:00:00-04:00');
  late_v1:=pg_temp.bind(late_v1,dp3); late_v2:=pg_temp.bind(late_v2,dp3);
  perform pg_temp.draft_refused(company,dp3,version_id,late_v1,'%stale or inactive pricing snapshot%');
  rc:=pg_temp.draft(company,dp3,next_version,late_v2,'#port-200');

  -- Stored outcomes, in the business's own currency. Part A: 30 × $16.85 = $505.50
  -- clears the $400 threshold, freight waived, tax 8.75% on products only → $549.73.
  perform pg_temp.port_assert((select invoice_number like '%A' and total_cents=54973 and currency='USD'
    from invoices where id=(ra->>'invoiceId')::uuid),'part A is $549.73 USD');
  -- Part B: 20 × $18.28 = $365.60 under the threshold, $5.00 freight, untaxed → $402.59.
  perform pg_temp.port_assert((select invoice_number like '%B' and total_cents=40259 and currency='USD'
    from invoices where id=(rb->>'invoiceId')::uuid),'part B is $402.59 USD');
  perform pg_temp.port_assert((select count(distinct left(invoice_number,-1))=1 and count(*)=2 from invoices i
    join invoice_calculation_snapshots s on s.invoice_id=i.id join dispatches d on d.id=s.dispatch_id
    where i.org_id=company and d.order_key=order1::text),'parts A/B share one order number');
  perform pg_temp.port_assert((select count(*)=1 from invoice_lines where invoice_id=(rb->>'invoiceId')::uuid and description='Freight' and total_cents=500)
    and not exists(select 1 from invoice_lines where invoice_id=(ra->>'invoiceId')::uuid and description='Freight'),
    'per-dispatch freight: waived on part A, charged on part B');
  -- Order 2 bills the v2 tier ($16.00 → $14.95 after discounts): 25 × $14.95 + $5.00 + tax = $411.45.
  perform pg_temp.port_assert((select total_cents=41145 and currency='USD' from invoices where id=(rc->>'invoiceId')::uuid),'order 2 bills the v2 price');
  -- Terms land on the 1st of the following month in the business's calendar.
  perform pg_temp.port_assert((select count(*)=3 from invoices i where i.org_id=company
    and (i.due_at at time zone 'America/New_York')::date=date '2026-11-01'),'due the 1st, New York calendar');

  -- Issue part A through the same operator approval path VICE uses.
  perform seed_chart_of_accounts(company);
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','controller.issue_invoice','approve_required');
  sha_a:=encode(sha256(convert_to(invoice_action_snapshot(company,(ra->>'invoiceId')::uuid)::text,'UTF8')),'hex');
  res:=operator_approve_invoice_part(company,(ra->>'invoiceId')::uuid,sha_a,operator,'ops@example.test','Portability probe');
  perform pg_temp.port_assert((select state='issued' from invoices where id=(ra->>'invoiceId')::uuid),'part A issued');
  perform pg_temp.port_assert(exists(select 1 from ledger_transactions t where t.org_id=company and t.source='invoice_issued'
    and t.source_ref=(ra->>'invoiceId')::uuid),'issuance posted to the ledger');

  -- Synthetic time travel for the statement probes only: the probe runs at any real
  -- date, so the issue instant is pinned inside the fixture's October window.
  execute 'alter table invoices disable trigger protect_billing_invoice';
  update invoices set issued_at='2026-10-25T12:00:00-04:00' where id=(ra->>'invoiceId')::uuid;
  execute 'alter table invoices enable trigger protect_billing_invoice';
  -- Statements age in the business's calendar. At 23:00 New York on 1 Nov (EST, after
  -- the clocks fall back — 17:00 on 2 Nov in Auckland) the invoice due that day is not
  -- yet overdue: with the business timezone it sits in the current bucket, where the
  -- previous business's timezone would already have aged it.
  select * into stmt from generate_statement_atomic(company,account,'2026-10-01T00:00:00-04:00','2026-11-01T23:00:00-05:00','probe','America/New_York');
  perform pg_temp.port_assert(stmt.closing_balance_cents=54973,'statement closes on the one issued invoice; drafts excluded');
  perform pg_temp.port_assert((select aging_current_cents=54973 and aging_30_cents=0 and currency='USD'
    from statements where id=stmt.statement_id),'not overdue in New York on its due date');
  -- Two weeks later the same invoice has aged into the 1–30 bucket.
  select * into stmt from generate_statement_atomic(company,account,'2026-10-01T00:00:00-04:00','2026-11-16T12:00:00-05:00','probe','America/New_York');
  perform pg_temp.port_assert((select aging_current_cents=0 and aging_30_cents=54973
    from statements where id=stmt.statement_id),'aged 15 days into the 1-30 bucket');

  -- Cross-business isolation over the whole database, which also holds the VICE-shaped
  -- business probed earlier: no row of either business leaks into the other.
  perform pg_temp.port_assert(not exists(select 1 from invoices where org_id=vice and currency='USD')
    and not exists(select 1 from invoices where org_id=company and currency<>'USD'),'currencies stay with their business');
  perform pg_temp.port_assert(not exists(select 1 from invoice_calculation_snapshots s join invoices i on i.id=s.invoice_id where s.org_id<>i.org_id)
    and not exists(select 1 from dispatch_allocations l join dispatches d on d.id=l.dispatch_id where l.org_id<>d.org_id),
    'snapshots and allocations never join across businesses');
  perform pg_temp.port_assert((select count(*)=2 from pricing_versions where org_id=company),'the contrast business holds only its own price list');
  perform pg_temp.port_assert(not exists(select 1 from statements where org_id<>company and account_id=account),'statements stay scoped to their business');

  raise notice 'PORT-01: order #port-100, 50 ordered USD, dispatched 30 then 20 (New York calendar)';
  raise notice '  part A $549.73 (tier price, both discounts, freight waived over the $400 threshold)';
  raise notice '  part B $402.59 (negotiated price below the tier, $5.00 untaxed per-dispatch freight)';
  raise notice '  order #port-200 after the price change: $411.45 under v2; v1 refused as stale (order-date basis)';
end $$;
