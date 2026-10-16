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
  org uuid; src uuid; o uuid; d uuid; k text; n int := 1000;
  line jsonb := '[{"source_line_key":"1","order_line_key":"1","item_key":"WIDGET","quantity":1,"ordered_quantity":1}]';
begin
  foreach org in array array['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222']::uuid[] loop
    src := bind_shopify_dispatch_source(org, 'jobs-'||left(org::text,4)||'.myshopify.com');
    foreach k in array case when org = '11111111-1111-4111-8111-111111111111'
      then array['blocked','quarantined','failed','pending'] else array['other'] end loop
      n := n + 1;
      insert into shopify_orders(org_id,shopify_order_id,shopify_order_name,currency,subtotal_cents,total_cents,raw,placed_at)
        values(org,'jobs-'||k,'#'||n,'NZD',0,0,'{}',now()) returning id into o;
      d := project_dispatch(org,src,'ship-'||k,o::text,now(),'succeeded',null,line,null,'{}',now());
      insert into shopify_fulfillments(org_id,shopify_fulfillment_id,shopify_order_id,status,tracking_numbers,raw,occurred_at,dispatch_id)
        values(org,'ship-'||k,o,'success',array['TRK-'||upper(k)],'{}',now(),d);
      insert into scheduled_jobs(org_id,job_key,kind,source_id,dispatch_id,state,attempts,next_attempt_at,last_error,updated_at)
        values(org,'carrier-cost:'||d,'carrier_cost_sync',src,d,
          case when k='other' then 'blocked' else k end,
          case k when 'quarantined' then 8 when 'blocked' then 2 when 'failed' then 1 else 0 end,
          case k when 'blocked' then now()+interval '5 hours' when 'failed' then now()+interval '2 minutes'
            when 'pending' then now()-interval '30 minutes' else now() end,
          case k when 'blocked' then 'GOSWEETSPOT_SITE_ID must be set'
            when 'quarantined' then 'gosweetspot: response does not cover every tracking number of the dispatch'
            when 'failed' then 'gosweetspot: shipments lookup failed with HTTP 503'
            when 'other' then 'OTHER-BUSINESS-SECRET-ERROR' end,
          now()-(n-1000)*interval '1 minute');
      if k = 'blocked' then
        insert into job_runs(org_id,job_key,attempt,started_at,finished_at,outcome,detail) values
          (org,'carrier-cost:'||d,1,now()-interval '70 minutes',now()-interval '69 minutes','retry','{"error":"gosweetspot: shipments lookup failed with HTTP 502"}'),
          (org,'carrier-cost:'||d,2,now()-interval '5 minutes',now()-interval '4 minutes','blocked','{"error":"GOSWEETSPOT_SITE_ID must be set"}');
      end if;
    end loop;
  end loop;
end $$;
grant usage on schema public to service_role;
grant select on all tables in schema public to service_role;
notify pgrst, 'reload schema';
