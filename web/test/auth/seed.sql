-- Only the disposable auth workflow calls this synthetic fixture.
insert into orgs(id,slug,display_name) values
 ('11111111-1111-4111-8111-111111111111','auth-browser','Auth browser fixture'),
 ('22222222-2222-4222-8222-222222222222','auth-other','Other synthetic business');
insert into invoices(org_id,invoice_number,state,currency,subtotal_cents,total_cents) values
 ('11111111-1111-4111-8111-111111111111','AUTH-ALLOWED-001','draft','NZD',1000,1000),
 ('22222222-2222-4222-8222-222222222222','AUTH-OTHER-SECRET-001','draft','NZD',2000,2000);
-- Background jobs (0029): one of each state the console must explain, plus another
-- business's blocked job that must never be shown.
do $$
declare
  org uuid; src uuid; o uuid; d uuid; f uuid; k text; n int := 1000;
  line jsonb := '[{"source_line_key":"1","order_line_key":"1","item_key":"WIDGET","quantity":1,"ordered_quantity":1}]';
begin
  foreach org in array array['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222']::uuid[] loop
    src := bind_shopify_dispatch_source(org, 'jobs-'||left(org::text,4)||'.myshopify.com');
    foreach k in array case when org = '11111111-1111-4111-8111-111111111111'
      then array['blocked','quarantined','failed','pending','courier'] else array['other'] end loop
      n := n + 1;
      insert into shopify_orders(org_id,shopify_order_id,shopify_order_name,currency,subtotal_cents,total_cents,raw,placed_at)
        values(org,'jobs-'||k,'#'||n,'NZD',0,0,'{}',now()) returning id into o;
      d := project_dispatch(org,src,'ship-'||k,o::text,now(),'succeeded',null,line,null,'{}',now());
      insert into shopify_fulfillments(org_id,shopify_fulfillment_id,shopify_order_id,status,tracking_numbers,raw,occurred_at,dispatch_id)
        values(org,'ship-'||k,o,'success',array['TRK-'||upper(k)],'{}',now(),d) returning id into f;
      -- The Controller routed these as wholesale: only wholesale shipments are costed and invoiced (0035).
      insert into fulfillment_events(org_id,shopify_fulfillment_id,shopify_order_id,route,occurred_at) values(org,f,o,'wholesale',now());
      insert into scheduled_jobs(org_id,job_key,kind,source_id,dispatch_id,state,attempts,next_attempt_at,last_error,updated_at)
        values(org,'carrier-cost:'||d,'carrier_cost_sync',src,d,
          case when k in ('other','courier') then 'blocked' else k end,
          case k when 'quarantined' then 8 when 'blocked' then 2 when 'failed' then 1 when 'courier' then 1 else 0 end,
          case k when 'blocked' then now()+interval '5 hours' when 'courier' then now()+interval '5 hours' when 'failed' then now()+interval '2 minutes'
            when 'pending' then now()-interval '30 minutes' else now() end,
          case k when 'blocked' then 'GOSWEETSPOT_SITE_ID must be set'
            when 'quarantined' then 'gosweetspot: response does not cover every tracking number of the dispatch'
            when 'failed' then 'gosweetspot: shipments lookup failed with HTTP 503'
            when 'courier' then 'gosweetspot: response does not cover every tracking number of the dispatch'
            when 'other' then 'OTHER-BUSINESS-SECRET-ERROR' end,
          now()-(n-1000)*interval '1 minute');
      if k = 'blocked' then
        insert into job_runs(org_id,job_key,attempt,started_at,finished_at,outcome,detail) values
          (org,'carrier-cost:'||d,1,now()-interval '70 minutes',now()-interval '69 minutes','retry','{"error":"gosweetspot: shipments lookup failed with HTTP 502"}'),
          (org,'carrier-cost:'||d,2,now()-interval '5 minutes',now()-interval '4 minutes','blocked','{"error":"GOSWEETSPOT_SITE_ID must be set"}');
      end if;
    end loop;
  end loop;
  -- Scheduled ingestion (0036): the connection's own sync job, blocked on a worker setting.
  -- It has no dispatch; the console names the connection instead.
  insert into scheduled_jobs(org_id,job_key,kind,source_id,dispatch_id,state,attempts,next_attempt_at,last_error,updated_at)
    select s.org_id,'shopify-sync:'||s.id,'shopify_sync',s.id,null,'blocked',1,now()+interval '6 hours',
      'SHOPIFY_ADMIN_API_TOKEN must be set',now()-interval '30 minutes'
    from dispatch_sources s where s.org_id='11111111-1111-4111-8111-111111111111' and s.provider='shopify';
end $$;
-- Pricing (0033): two products and two retailers to price, and another business's product
-- and retailer that the editor must never offer.
insert into products(org_id,sku,display_name) values
 ('11111111-1111-4111-8111-111111111111','TEE','Synthetic tee'),
 ('11111111-1111-4111-8111-111111111111','CAP','Synthetic cap'),
 ('22222222-2222-4222-8222-222222222222','SECRET','OTHER-SECRET-PRODUCT');
insert into accounts(org_id,name,tax_exempt) values
 ('11111111-1111-4111-8111-111111111111','Synthetic Retail North',false),
 ('11111111-1111-4111-8111-111111111111','Synthetic Export',true),
 ('22222222-2222-4222-8222-222222222222','OTHER-SECRET-RETAILER',false);
-- Approve → print (0034): a retailer's Shopify order shipped in full, ready for the browser
-- journey to draft its invoice part through the real BILL path once pricing is active, and
-- the chart of accounts issuing posts to (an onboarding step).
do $$
declare org uuid := '11111111-1111-4111-8111-111111111111'; o uuid;
begin
  perform seed_chart_of_accounts(org);
  insert into shopify_customers(org_id,shopify_customer_id,raw,account_id)
    select org,'cust-north','{}',id from accounts where org_id=org and name='Synthetic Retail North';
  insert into shopify_orders(org_id,shopify_order_id,shopify_order_name,shopify_customer_id,currency,subtotal_cents,total_cents,raw,placed_at)
    values(org,'print-1','#5001','cust-north','NZD',0,0,'{}','2026-10-10T09:00:00+13:00') returning id into o;
  perform project_dispatch(org,bind_shopify_dispatch_source(org,'jobs-1111.myshopify.com'),'ship-print-1',o::text,'2026-10-12T09:00:00+13:00',
    'succeeded',null,'[{"source_line_key":"1","order_line_key":"1","item_key":"TEE","quantity":10,"ordered_quantity":10}]',null,'{}','2026-10-12T09:00:00+13:00');
end $$;
-- Step 4c: a wholesale-routed shipment the worker's invoice part job drafts by itself.
do $$
declare org uuid := '11111111-1111-4111-8111-111111111111'; o uuid; d uuid; f uuid;
begin
  insert into shopify_orders(org_id,shopify_order_id,shopify_order_name,shopify_customer_id,currency,subtotal_cents,total_cents,raw,placed_at)
    values(org,'auto-1','#5002','cust-north','NZD',0,0,'{}','2026-10-13T09:00:00+13:00') returning id into o;
  d := project_dispatch(org,bind_shopify_dispatch_source(org,'jobs-1111.myshopify.com'),'ship-auto-1',o::text,'2026-10-14T09:00:00+13:00',
    'succeeded',null,'[{"source_line_key":"1","order_line_key":"1","item_key":"TEE","quantity":4,"ordered_quantity":4}]',null,'{}','2026-10-14T09:00:00+13:00');
  insert into shopify_fulfillments(org_id,shopify_fulfillment_id,shopify_order_id,status,raw,occurred_at,dispatch_id)
    values(org,'ship-auto-1',o,'success','{}','2026-10-14T09:00:00+13:00',d) returning id into f;
  insert into fulfillment_events(org_id,shopify_fulfillment_id,shopify_order_id,account_id,route,occurred_at)
    select org,f,o,id,'wholesale','2026-10-14T09:00:00+13:00' from accounts where org_id=org and name='Synthetic Retail North';
end $$;
-- Console operators may retry and dismiss stopped jobs in the fixture business only (boot seeds these grants).
insert into tool_grants(org_id,agent_name,tool_name,risk) values
 ('11111111-1111-4111-8111-111111111111','operator','jobs.retry','notify'),
 ('11111111-1111-4111-8111-111111111111','operator','jobs.dismiss','notify'),
 -- Not seeded at boot; a business turns manual carrier costs on deliberately, as here.
 ('11111111-1111-4111-8111-111111111111','operator','carriers.record_manual_cost','notify'),
 -- Boot seeds the pricing grants too (0033).
 ('11111111-1111-4111-8111-111111111111','operator','pricing.save','notify'),
 ('11111111-1111-4111-8111-111111111111','operator','pricing.activate','notify'),
 ('11111111-1111-4111-8111-111111111111','operator','invoices.record_print','notify'),
 -- Never seeded at boot; a business turns invoice issuing on deliberately, as here.
 ('11111111-1111-4111-8111-111111111111','operator','controller.issue_invoice','approve_required');
-- Approvals (0037): two pending bound proposals the journey decides, and another
-- business's pending approval that must never be shown.
do $$
declare org uuid; intent jsonb;
begin
  insert into tool_grants(org_id,agent_name,tool_name,risk) values
   ('11111111-1111-4111-8111-111111111111','operator','approvals.decide','notify'),
   ('11111111-1111-4111-8111-111111111111','controller','demo.widget_restock','approve_required'),
   ('22222222-2222-4222-8222-222222222222','controller','demo.widget_restock','approve_required');
  foreach org in array array['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222']::uuid[] loop
    intent:=jsonb_build_object('org_id',org,'schema_version','1','tool_name','demo.widget_restock','agent_name','controller',
      'input','{}'::jsonb,'subject_snapshot','{}'::jsonb,'policy_snapshot',null,'subject_type','observation','subject_id',null);
    if org='11111111-1111-4111-8111-111111111111' then
      perform create_bound_approval(org,intent,now()+interval '2 days','Restock widget order #88');
      perform create_bound_approval(org,intent,now()+interval '2 days','Credit note for order #91');
    else
      perform create_bound_approval(org,intent,now()+interval '2 days','OTHER-APPROVAL-SECRET');
    end if;
  end loop;
end $$;
-- Daily briefing (0038): a fresh grounded narration the home page shows, with a cited
-- record. The grounding check runs in the worker; this stores the evidence shape.
select record_daily_briefing('11111111-1111-4111-8111-111111111111','fixture-model','{}'::jsonb,
  'Two proposals wait for a decision and one connection has never synced.',
  '[{"kind":"approval","id":"00000000-0000-4000-8000-00000000aaaa","label":"pending approval: demo.widget_restock"}]'::jsonb,
  'ok',null);
grant usage on schema public to service_role;
grant select on all tables in schema public to service_role;
notify pgrst, 'reload schema';
