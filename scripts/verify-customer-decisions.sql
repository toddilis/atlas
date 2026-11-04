-- CONFIG-01d customer invoicing decisions (0054): grant/pause/identity, stale edits, a
-- same-business open retailer, a reason to stop invoicing, held shipments released with
-- the decision in the same transaction (unpaid to invoicing, paid not invoiced), repeats
-- without a second audit row, decisions surviving a sync upsert, and the console search
-- (literal, business-scoped) — against a real disposable database.
create function pg_temp.cd_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT CUSTOMER DECISIONS: %',msg; end if; end $$;
create function pg_temp.cd_reject(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like pattern then raise; end if; return; end;
  raise exception 'ASSERT CUSTOMER DECISIONS expected rejection: %',pattern;
end $$;
-- One shipped draft order the Controller held: order, dispatch, fulfillment and a 'held'
-- routing record, as routing.ts writes it for an unpaid draft order of an undecided customer.
create function pg_temp.cd_held(company uuid,source uuid,customer text,order_key text,status text) returns uuid language plpgsql as $$
declare o uuid; d uuid; f uuid; e uuid; rev timestamptz:='2026-11-02T09:00:00+13:00';
begin
  insert into shopify_orders(org_id,shopify_order_id,shopify_customer_id,currency,subtotal_cents,total_cents,financial_status,raw,placed_at)
    values(company,order_key,customer,'NZD',0,0,status,'{"source_name":"shopify_draft_order"}',rev) returning id into o;
  d:=project_dispatch(company,source,'ship-'||order_key,o::text,rev,'succeeded',null,
    '[{"source_line_key":"1","order_line_key":"1","item_key":"WIDGET","quantity":1,"ordered_quantity":1}]',null,'{}',rev);
  insert into shopify_fulfillments(org_id,shopify_fulfillment_id,shopify_order_id,status,raw,occurred_at,dispatch_id)
    values(company,'ship-'||order_key,o,'success','{}',rev,d) returning id into f;
  insert into fulfillment_events(org_id,shopify_fulfillment_id,shopify_order_id,route,reason,occurred_at)
    values(company,f,o,'held','unpaid draft order from a customer not yet linked to a retailer',rev) returning id into e;
  return e;
end $$;
do $$
declare
  company uuid:='89000000-0000-4000-8000-000000000001'; other uuid:='89000000-0000-4000-8000-000000000002';
  operator uuid:='89000000-0000-4000-8000-0000000000aa'; email text:='ops@example.test';
  shop uuid; closed_acct uuid; foreign_acct uuid; c_shop uuid; c_rep uuid; c_ahead uuid; c_foreign uuid;
  source uuid; other_source uuid; e_unpaid uuid; e_paid uuid; e_rep uuid; e_foreign uuid; d_unpaid uuid; r record; n integer;
  decide text:='select * from operator_decide_shopify_customer(%L,%L,%L,%L,%L,%L,%L,%L)';
begin
  insert into orgs(id,slug,display_name) values(company,'decide-fixture','Synthetic customer decisions'),(other,'decide-other','Other decisions drill');
  insert into accounts(org_id,name) values(company,'Shop Retailer') returning id into shop;
  insert into accounts(org_id,name,status) values(company,'Closed Retailer','closed') returning id into closed_acct;
  insert into accounts(org_id,name) values(other,'Other business retailer') returning id into foreign_acct;
  insert into shopify_customers(org_id,shopify_customer_id,email,first_name,last_name,default_address,raw)
    values(company,'c-shop','komal@levin-sports.test','Komal',null,'{"company":"Levin Sports"}','{}') returning id into c_shop;
  insert into shopify_customers(org_id,shopify_customer_id,email,first_name,last_name,default_address,raw)
    values(company,'c-rep','rep@vice-fixture.test','Andy','Rep',null,'{}') returning id into c_rep;
  insert into shopify_customers(org_id,shopify_customer_id,email,first_name,last_name,default_address,raw)
    values(company,'c-ahead','fay@future-shop.test','Fay','Buyer','{"company":"Future Shop"}','{}') returning id into c_ahead;
  insert into shopify_customers(org_id,shopify_customer_id,email,first_name,last_name,default_address,raw)
    values(other,'c-foreign','komal@other.test','Komal','Other','{"company":"Levin Sports"}','{}') returning id into c_foreign;
  source:=bind_shopify_dispatch_source(company,'decide-fixture.myshopify.com');
  other_source:=bind_shopify_dispatch_source(other,'decide-other.myshopify.com');
  e_unpaid:=pg_temp.cd_held(company,source,'c-shop','o-unpaid','pending');
  e_paid:=pg_temp.cd_held(company,source,'c-shop','o-paid','pending');
  e_rep:=pg_temp.cd_held(company,source,'c-rep','o-rep','pending');
  e_foreign:=pg_temp.cd_held(other,other_source,'c-shop','o-foreign','pending');
  select d.id into d_unpaid from dispatches d where d.org_id=company and d.source_dispatch_key='ship-o-unpaid';
  perform pg_temp.cd_assert(not dispatch_routed_wholesale(company,d_unpaid) and not invoice_part_job_needed(company,source,d_unpaid),
    'a held shipment is not invoiced');

  -- Off until granted; approve_required refused; pause and identity hold.
  perform pg_temp.cd_reject(format(decide,company,c_shop,'retailer',shop,null,'undecided',operator,email),'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','customers.decide','approve_required');
  perform pg_temp.cd_reject(format(decide,company,c_shop,'retailer',shop,null,'undecided',operator,email),'%must not require approval%');
  update tool_grants set risk='notify' where org_id=company and tool_name='customers.decide';
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.cd_reject(format(decide,company,c_shop,'retailer',shop,null,'undecided',operator,email),'%business actions paused%');
  perform set_action_pause(company,false,'probe','probe resume');
  perform pg_temp.cd_reject(format(decide,company,c_shop,'retailer',shop,null,'undecided',null,email),'%operator identity required%');
  perform pg_temp.cd_reject(format(decide,company,c_shop,'retailer',shop,null,'undecided',operator,' '),'%operator identity required%');
  perform pg_temp.cd_reject(format(decide,company,c_shop,'maybe',shop,null,'undecided',operator,email),'%customer decision required%');

  -- Only this business's customers and open retailers; the page's token must be current.
  perform pg_temp.cd_reject(format(decide,company,gen_random_uuid(),'retailer',shop,null,'undecided',operator,email),'%shopify customer not found%');
  perform pg_temp.cd_reject(format(decide,company,c_foreign,'retailer',shop,null,'undecided',operator,email),'%shopify customer not found%');
  perform pg_temp.cd_reject(format(decide,company,c_shop,'retailer',foreign_acct,null,'undecided',operator,email),'%retailer not found%');
  perform pg_temp.cd_reject(format(decide,company,c_shop,'retailer',null,null,'undecided',operator,email),'%retailer not found%');
  perform pg_temp.cd_reject(format(decide,company,c_shop,'retailer',closed_acct,null,'undecided',operator,email),'%retailer is closed%');
  perform pg_temp.cd_reject(format(decide,company,c_shop,'retailer',shop,null,'not_invoiced',operator,email),'%changed since it was loaded%');
  perform pg_temp.cd_reject(format(decide,company,c_shop,'retailer',shop,null,null,operator,email),'%changed since it was loaded%');
  perform pg_temp.cd_assert((select count(*) from audit_log where org_id=company and action='customers.decide')=0,'refusals leave no audit row');

  -- Paid by the time anyone decides: never invoiced, even once linked.
  update shopify_orders set financial_status='paid' where org_id=company and shopify_order_id='o-paid';

  -- Linking releases the customer's held shipments in the same transaction.
  select * into r from operator_decide_shopify_customer(company,c_shop,'retailer',shop,'ignored note','undecided',operator,email);
  perform pg_temp.cd_assert(r.odc_released=1 and r.odc_not_invoiced=1 and not r.odc_unchanged,'link releases 1 to invoicing, 1 not invoiced: '||row_to_json(r)::text);
  select * into r from fulfillment_events where id=e_unpaid;
  perform pg_temp.cd_assert(r.route='wholesale' and r.account_id=shop
    and r.reason='released to invoicing: customer linked to Shop Retailer by ops@example.test','unpaid shipment released to invoicing');
  perform pg_temp.cd_assert(dispatch_routed_wholesale(company,d_unpaid) and invoice_part_job_needed(company,source,d_unpaid),
    'the released shipment is what invoice part discovery looks for');
  select * into r from fulfillment_events where id=e_paid;
  perform pg_temp.cd_assert(r.route='ignored' and r.account_id is null
    and r.reason='not invoiced: paid in Shopify when its customer was linked by ops@example.test','paid shipment not invoiced');
  perform pg_temp.cd_assert((select route from fulfillment_events where id=e_rep)='held','another customer''s shipment stays held');
  perform pg_temp.cd_assert((select route from fulfillment_events where id=e_foreign)='held'
    and (select account_id from shopify_customers where id=c_foreign) is null,'another business is untouched, even with the same Shopify id');
  select * into r from shopify_customers where id=c_shop;
  perform pg_temp.cd_assert(r.account_id=shop and not r.do_not_invoice and r.decision_note is null and r.decided_by=email
    and r.decided_at is not null and (select shopify_customer_decision(c) from shopify_customers c where c.id=c_shop)=shop::text,'customer linked, with who and when');
  select * into r from audit_log where org_id=company and action='customers.decide';
  perform pg_temp.cd_assert(r.subject_id=c_shop and r.risk='notify' and r.outcome='success' and r.detail->>'from'='undecided'
    and r.detail->>'to'=shop::text and (r.detail->>'released')::int=1 and (r.detail->>'not_invoiced')::int=1
    and r.detail->>'actor_email'=email,'decision audited: '||r.detail::text);

  -- A retried submit is a no-op: no second audit row, nothing more released.
  select * into r from operator_decide_shopify_customer(company,c_shop,'retailer',shop,null,'undecided',operator,email);
  perform pg_temp.cd_assert(r.odc_unchanged and r.odc_released=0,'repeat is unchanged');
  perform pg_temp.cd_assert((select count(*) from audit_log where org_id=company and action='customers.decide')=1,'repeat not audited twice');

  -- Never invoicing a customer needs a reason; its held shipments are released as not invoiced.
  perform pg_temp.cd_reject(format(decide,company,c_rep,'not_invoiced',null,'  ','undecided',operator,email),'%a reason is required%');
  perform pg_temp.cd_reject(format(decide,company,c_rep,'not_invoiced',null,'ok','undecided',operator,email),'%a reason is required%');
  perform pg_temp.cd_reject(format(decide,company,c_rep,'not_invoiced',null,repeat('x',501),'undecided',operator,email),'%reason too long%');
  select * into r from operator_decide_shopify_customer(company,c_rep,'not_invoiced',shop,'  Rep kit  ','undecided',operator,email);
  perform pg_temp.cd_assert(r.odc_released=0 and r.odc_not_invoiced=1,'rep shipment released as not invoiced');
  perform pg_temp.cd_assert((select route='ignored' and account_id is null
    and reason='not invoiced: customer marked not invoiced by ops@example.test (Rep kit)' from fulfillment_events where id=e_rep),'rep reason recorded');
  select * into r from shopify_customers where id=c_rep;
  perform pg_temp.cd_assert(r.do_not_invoice and r.account_id is null and r.decision_note='Rep kit'
    and (select shopify_customer_decision(c) from shopify_customers c where c.id=c_rep)='not_invoiced','rep marked not invoiced, retailer ignored');
  perform pg_temp.cd_reject(format('update shopify_customers set account_id=%L where id=%L',shop,c_rep),'%shopify_customers_one_decision%');
  perform pg_temp.cd_reject(format('update shopify_customers set do_not_invoice=true where id=%L',c_ahead),'%shopify_customers_not_invoiced_reason%');

  -- Undo: back to undecided, the reason cleared. Later held shipments wait again.
  select * into r from operator_decide_shopify_customer(company,c_rep,'undecided',null,null,'not_invoiced',operator,email);
  select * into r from shopify_customers where id=c_rep;
  perform pg_temp.cd_assert(not r.do_not_invoice and r.account_id is null and r.decision_note is null
    and (select shopify_customer_decision(c) from shopify_customers c where c.id=c_rep)='undecided','rep back to undecided');

  -- Linking ahead of any shipment releases nothing and still records the decision.
  select * into r from operator_decide_shopify_customer(company,c_ahead,'retailer',shop,null,'undecided',operator,email);
  perform pg_temp.cd_assert(r.odc_released=0 and r.odc_not_invoiced=0 and not r.odc_unchanged,'linking ahead');
  perform pg_temp.cd_assert((select account_id from shopify_customers where id=c_ahead)=shop,'linked ahead');

  -- The sync's upsert names its own columns, so decisions survive it.
  insert into shopify_customers(org_id,shopify_customer_id,email,raw,synced_at)
    values(company,'c-shop','komal.new@levin-sports.test','{"synced":true}',now())
  on conflict (org_id,shopify_customer_id) do update set email=excluded.email,raw=excluded.raw,synced_at=excluded.synced_at;
  select * into r from shopify_customers where id=c_shop;
  perform pg_temp.cd_assert(r.email='komal.new@levin-sports.test' and r.account_id=shop and r.decided_by=email,'decision survives a sync');

  -- Search: literal, case-insensitive, this business only.
  perform pg_temp.cd_assert((select array_agg(shopify_customer_id order by shopify_customer_id) from search_shopify_customers(company,'levin'))
    =array['c-shop'],'company match, not the other business''s Levin Sports');
  perform pg_temp.cd_assert((select array_agg(shopify_customer_id) from search_shopify_customers(company,'  KOMAL '))=array['c-shop'],'name, any case');
  perform pg_temp.cd_assert((select array_agg(shopify_customer_id) from search_shopify_customers(company,'fay buyer'))=array['c-ahead'],'full name');
  perform pg_temp.cd_assert((select array_agg(shopify_customer_id) from search_shopify_customers(company,'c-rep'))=array['c-rep'],'Shopify id');
  perform pg_temp.cd_assert((select count(*) from search_shopify_customers(company,'%'))=0,'LIKE wildcards match literally');
  perform pg_temp.cd_assert((select count(*) from search_shopify_customers(company,'k'))=0,'one character finds nothing');
  perform pg_temp.cd_assert((select count(*) from search_shopify_customers(company,'.test',1))=1,'limit applies');
  select * into r from search_shopify_customers(company,'future');
  perform pg_temp.cd_assert(r.company='Future Shop' and r.account_id=shop and r.decided_by=email,'search returns the decision: '||row_to_json(r)::text);

  -- Service role only.
  select count(*) into n from pg_proc p cross join (select unnest(array['anon','authenticated']) as rolname) x
    where p.pronamespace='public'::regnamespace
      and p.proname in ('operator_decide_shopify_customer','search_shopify_customers','shopify_customer_decision')
      and exists(select 1 from pg_roles where pg_roles.rolname=x.rolname) and has_function_privilege(x.rolname,p.oid,'execute');
  perform pg_temp.cd_assert(n=0,'decision functions are not executable by anon or authenticated');
  raise notice 'OK: customer decisions — grant/pause/identity, stale token, open same-business retailer, reasons, held shipments released with the decision (unpaid to invoicing, paid not), repeats, sync, search';
end $$;
