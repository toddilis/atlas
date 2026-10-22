-- CONFIG-01b console Shopify connection (0042): grant/pause/identity enforcement,
-- canonical-domain and one-per-business rules (owned by bind_shopify_dispatch_source),
-- cadence bounds, stale edits, the fixed connection key, audit, the scheduled-sync
-- machinery (0036) following enable/disable, cross-business reach and role privileges.
create function pg_temp.conn_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT CONNECTIONS: %',msg; end if; end $$;
create function pg_temp.conn_reject(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like pattern then raise; end if; return; end;
  raise exception 'ASSERT CONNECTIONS expected rejection: %',pattern;
end $$;
do $$
declare
  company uuid:='78000000-0000-4000-8000-000000000001'; operator uuid:='78000000-0000-4000-8000-0000000000aa';
  source uuid; vice_source uuid; t timestamptz; connect_cmd text;
begin
  insert into orgs(id,slug,display_name) values(company,'connection-fixture','Synthetic connection drill');
  connect_cmd:=format('select operator_save_shopify_connection(%L,null,%L,true,30,null,%L,%L)',company,'drill-shop.myshopify.com',operator,'ops@example.test');

  -- Off until granted; pause and identity rules hold; the domain must be canonical.
  perform pg_temp.conn_reject(connect_cmd,'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','connections.save','notify');
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.conn_reject(connect_cmd,'%business actions paused%');
  perform set_action_pause(company,false,'probe','probe resume');
  perform pg_temp.conn_reject(format('select operator_save_shopify_connection(%L,null,%L,true,30,null,null,%L)',company,'drill-shop.myshopify.com','ops@example.test'),'%operator identity required%');
  perform pg_temp.conn_reject(format('select operator_save_shopify_connection(%L,null,%L,true,30,null,%L,%L)',company,'https://drill-shop.example.com',operator,'ops@example.test'),'%canonical Shopify shop domain%');
  perform pg_temp.conn_reject(format('select operator_save_shopify_connection(%L,null,%L,true,0,null,%L,%L)',company,'drill-shop.myshopify.com',operator,'ops@example.test'),'%sync cadence minutes out of range%');

  -- Connect once, retry-stable and audited once; a second shop is refused, never rebound.
  execute connect_cmd into source;
  perform pg_temp.conn_assert((select connection_key='drill-shop.myshopify.com' and enabled and sync_every_minutes=30
    from dispatch_sources where id=source),'connected with the chosen cadence');
  perform pg_temp.conn_assert((select operator_save_shopify_connection(company,null,'drill-shop.myshopify.com',true,30,null,operator,'ops@example.test'))=source,'connect retry stable');
  perform pg_temp.conn_assert((select count(*)=1 from audit_log where org_id=company and action='connections.save'),'connect audited once');
  perform pg_temp.conn_reject(format('select operator_save_shopify_connection(%L,null,%L,true,30,null,%L,%L)',company,'other-shop.myshopify.com',operator,'ops@example.test'),'%already has its Shopify connection%');

  -- The scheduled sync follows the connection: enabled and never-synced arms a job.
  perform pg_temp.conn_assert(discover_shopify_sync_jobs(company)=1,'discovery arms the enabled connection');
  perform pg_temp.conn_assert((select count(*)=1 from scheduled_jobs where org_id=company and kind='shopify_sync' and source_id=source),'one sync job for the connection');

  -- Edits need the loaded row's timestamp; the shop domain is fixed; cadence stays bounded.
  perform pg_temp.conn_reject(format('select operator_save_shopify_connection(%L,%L,null,true,45,null,%L,%L)',company,source,operator,'ops@example.test'),'%changed since it was loaded%');
  t:=(select updated_at from dispatch_sources where id=source);
  perform pg_temp.conn_reject(format('select operator_save_shopify_connection(%L,%L,%L,true,45,%L,%L,%L)',company,source,'renamed.myshopify.com',t,operator,'ops@example.test'),'%shop domain is fixed%');
  perform pg_temp.conn_reject(format('select operator_save_shopify_connection(%L,%L,null,true,1441,%L,%L,%L)',company,source,t,operator,'ops@example.test'),'%sync cadence minutes out of range%');
  perform operator_save_shopify_connection(company,source,null,false,45,t,operator,'ops@example.test');
  perform pg_temp.conn_assert((select not enabled and sync_every_minutes=45 and updated_at>t from dispatch_sources where id=source),'edited, disabled and touched');
  perform pg_temp.conn_assert((select count(*)=2 from audit_log where org_id=company and action='connections.save'),'edit audited');

  -- Disabled means the sync is no longer needed; re-enabling arms it again.
  perform pg_temp.conn_assert(not shopify_sync_job_needed(company,source),'a disabled connection needs no sync');
  t:=(select updated_at from dispatch_sources where id=source);
  perform operator_save_shopify_connection(company,source,null,true,45,t,operator,'ops@example.test');
  perform pg_temp.conn_assert(shopify_sync_job_needed(company,source),'an enabled connection needs its sync again');

  -- Another business's connection is unreachable from here.
  select id into vice_source from dispatch_sources where org_id='63000000-0000-4000-8000-000000000001' and provider='shopify';
  perform pg_temp.conn_reject(format('select operator_save_shopify_connection(%L,%L,null,false,15,%L,%L,%L)',company,vice_source,now(),operator,'ops@example.test'),'%connection not found%');
  perform pg_temp.conn_assert((select enabled from dispatch_sources where id=vice_source),'other business untouched');

  perform pg_temp.conn_assert(not has_function_privilege('anon','operator_save_shopify_connection(uuid,uuid,text,boolean,integer,timestamptz,uuid,text)','execute')
    and not has_function_privilege('authenticated','operator_save_shopify_connection(uuid,uuid,text,boolean,integer,timestamptz,uuid,text)','execute')
    and has_function_privilege('service_role','operator_save_shopify_connection(uuid,uuid,text,boolean,integer,timestamptz,uuid,text)','execute'),
    'the connection entry point is service-only');
  raise notice 'OK: console Shopify connection — grant/pause/identity, canonical domain, one per business, fixed key, cadence bounds, stale edits, sync-job wiring, audit and role probes';
end $$;
