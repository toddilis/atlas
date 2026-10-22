-- CONFIG-01a console catalogue (0040): grant and pause enforcement, create/edit for
-- products and retailers, duplicate and stale-edit refusals, synced-sku and
-- fixed-currency protection, retry stability, audit, cross-business reach and
-- role privileges — against a real disposable database.
create function pg_temp.cat_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT CATALOG: %',msg; end if; end $$;
create function pg_temp.cat_reject(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like pattern then raise; end if; return; end;
  raise exception 'ASSERT CATALOG expected rejection: %',pattern;
end $$;
do $$
declare
  company uuid:='76000000-0000-4000-8000-000000000001'; other uuid:='76000000-0000-4000-8000-000000000002';
  operator uuid:='76000000-0000-4000-8000-0000000000aa';
  gizmo uuid; widget uuid; synced uuid; retailer uuid; second uuid; foreign_product uuid; t timestamptz;
  save_product text;
begin
  insert into orgs(id,slug,display_name) values(company,'catalog-fixture','Synthetic catalogue'),(other,'catalog-other','Other business');
  insert into products(id,org_id,sku,display_name) values(gen_random_uuid(),other,'FOREIGN','Other business product') returning id into foreign_product;
  select id into foreign_product from products where org_id=other and sku='FOREIGN';

  -- Switched off until the business grants it; paused businesses change nothing.
  save_product:=format('select operator_save_product(%L,null,%L,%L,%L,true,null,%L,%L)',company,'GIZMO','Synthetic gizmo','each',operator,'ops@example.test');
  perform pg_temp.cat_reject(save_product,'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values
    (company,'operator','catalog.save','notify'),(company,'operator','accounts.save','notify');
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.cat_reject(save_product,'%business actions paused%');
  perform set_action_pause(company,false,'probe','probe resume');
  perform pg_temp.cat_reject(format('select operator_save_product(%L,null,%L,%L,%L,true,null,null,%L)',company,'GIZMO','Synthetic gizmo','each','ops@example.test'),'%operator identity required%');

  -- Create, retry-stable, audited once; blank and oversized fields refused.
  gizmo:=operator_save_product(company,null,' GIZMO ','Synthetic gizmo','each',true,null,operator,'ops@example.test');
  perform pg_temp.cat_assert(operator_save_product(company,null,'GIZMO','Synthetic gizmo','each',true,null,operator,'ops@example.test')=gizmo,'product create retry stable');
  perform pg_temp.cat_assert((select count(*)=1 from audit_log where org_id=company and action='catalog.save' and subject_id=gizmo),'product create audited once');
  perform pg_temp.cat_assert((select sku='GIZMO' and display_name='Synthetic gizmo' and active from products where id=gizmo),'product stored trimmed');
  perform pg_temp.cat_reject(format('select operator_save_product(%L,null,%L,%L,%L,true,null,%L,%L)',company,'GIZMO','Another name','each',operator,'ops@example.test'),'%sku already exists%');
  perform pg_temp.cat_reject(format('select operator_save_product(%L,null,%L,%L,%L,true,null,%L,%L)',company,'  ','No sku','each',operator,'ops@example.test'),'%catalogue fields required%');
  perform pg_temp.cat_reject(format('select operator_save_product(%L,null,%L,%L,%L,true,null,%L,%L)',company,repeat('X',65),'Too long','each',operator,'ops@example.test'),'%catalogue field too long%');

  -- Edit needs the loaded row's timestamp; a stale or missing one changes nothing.
  perform pg_temp.cat_reject(format('select operator_save_product(%L,%L,%L,%L,%L,true,null,%L,%L)',company,gizmo,'GIZMO','Renamed','each',operator,'ops@example.test'),'%changed since it was loaded%');
  t:=(select updated_at from products where id=gizmo);
  widget:=operator_save_product(company,gizmo,'GIZMO','Synthetic gizmo mk2','box',true,t,operator,'ops@example.test');
  perform pg_temp.cat_assert(widget=gizmo and (select display_name='Synthetic gizmo mk2' and unit='box' and updated_at>t from products where id=gizmo),'product edited and touched');
  perform pg_temp.cat_reject(format('select operator_save_product(%L,%L,%L,%L,%L,true,%L,%L,%L)',company,gizmo,'GIZMO','Stale again','each',t,operator,'ops@example.test'),'%changed since it was loaded%');

  -- A synced product's sku is its source identity; other fields stay editable.
  insert into products(org_id,sku,display_name,shopify_product_id) values(company,'SYNCED','Synced product','shopify-1') returning id into synced;
  t:=(select updated_at from products where id=synced);
  perform pg_temp.cat_reject(format('select operator_save_product(%L,%L,%L,%L,%L,true,%L,%L,%L)',company,synced,'RENAMED','Synced product','each',t,operator,'ops@example.test'),'%synced product sku is fixed%');
  perform operator_save_product(company,synced,'SYNCED','Synced, renamed in the console','each',true,t,operator,'ops@example.test');

  -- Another business's product is unreachable, by id or by duplicate-sku collision.
  perform pg_temp.cat_reject(format('select operator_save_product(%L,%L,%L,%L,%L,true,null,%L,%L)',company,foreign_product,'FOREIGN','Hijack','each',operator,'ops@example.test'),'%product not found%');
  perform operator_save_product(company,null,'FOREIGN','Same sku, this business',  'each',true,null,operator,'ops@example.test');
  perform pg_temp.cat_assert((select display_name='Other business product' from products where id=foreign_product),'other business untouched');

  -- Retailers: validity, create, retry, duplicate, stale, status and email rules.
  retailer:=operator_save_account(company,null,'Importer','usd',false,14,null,'active',null,operator,'ops@example.test');
  perform pg_temp.cat_assert((select currency='USD' from accounts where id=retailer),'currency stored upper-cased');
  perform pg_temp.cat_assert(operator_save_account(company,null,'Importer','USD',false,14,null,'active',null,operator,'ops@example.test')=retailer,'retailer create retry stable');
  perform pg_temp.cat_assert((select count(*)=1 from audit_log where org_id=company and action='accounts.save' and subject_id=retailer),'retailer create audited once');
  perform pg_temp.cat_reject(format('select operator_save_account(%L,null,%L,%L,true,14,null,%L,null,%L,%L)',company,'Importer','USD','active',operator,'ops@example.test'),'%retailer name already exists%');
  perform pg_temp.cat_reject(format('select operator_save_account(%L,null,%L,%L,false,14,null,%L,null,%L,%L)',company,'Bad currency','US','active',operator,'ops@example.test'),'%3-letter code%');
  perform pg_temp.cat_reject(format('select operator_save_account(%L,null,%L,%L,false,-1,null,%L,null,%L,%L)',company,'Bad terms','USD','active',operator,'ops@example.test'),'%out of range%');
  perform pg_temp.cat_reject(format('select operator_save_account(%L,null,%L,%L,false,14,null,%L,null,%L,%L)',company,'Bad status','USD','frozen',operator,'ops@example.test'),'%unknown retailer status%');
  perform pg_temp.cat_reject(format('select operator_save_account(%L,null,%L,%L,false,14,%L,%L,null,%L,%L)',company,'Bad email','USD','not-an-email','active',operator,'ops@example.test'),'%billing email invalid%');
  perform pg_temp.cat_reject(format('select operator_save_account(%L,%L,%L,%L,false,14,null,%L,null,%L,%L)',company,retailer,'Importer','USD','active',operator,'ops@example.test'),'%changed since it was loaded%');
  t:=(select updated_at from accounts where id=retailer);
  second:=operator_save_account(company,null,'Second retailer','USD',false,30,'ops@retailer.test','active',null,operator,'ops@example.test');
  perform pg_temp.cat_reject(format('select operator_save_account(%L,%L,%L,%L,false,14,null,%L,%L,%L,%L)',company,retailer,'Second retailer','USD','active',t,operator,'ops@example.test'),'%retailer name already exists%');

  -- Currency is fixed once the retailer has invoices; everything else stays editable.
  insert into invoices(org_id,account_id,invoice_number,state,currency,subtotal_cents,total_cents) values(company,retailer,'CAT-1','draft','USD',100,100);
  perform pg_temp.cat_reject(format('select operator_save_account(%L,%L,%L,%L,false,14,null,%L,%L,%L,%L)',company,retailer,'Importer','EUR','active',t,operator,'ops@example.test'),'%currency is fixed once it has invoices%');
  perform operator_save_account(company,retailer,'Importer','USD',true,20,'billing@importer.test','dormant',t,operator,'ops@example.test');
  perform pg_temp.cat_assert((select tax_exempt and payment_terms_days=20 and billing_email='billing@importer.test' and status='dormant' and updated_at>t
    from accounts where id=retailer),'retailer edited and touched');

  -- Revoking the grant switches the console action off again.
  update tool_grants set enabled=false where org_id=company and agent_name='operator' and tool_name='catalog.save';
  perform pg_temp.cat_reject(format('select operator_save_product(%L,null,%L,%L,%L,true,null,%L,%L)',company,'LATER','After revocation','each',operator,'ops@example.test'),'%tool entitlement missing or revoked%');

  perform pg_temp.cat_assert(not has_function_privilege('anon','operator_save_product(uuid,uuid,text,text,text,boolean,timestamptz,uuid,text)','execute')
    and not has_function_privilege('authenticated','operator_save_account(uuid,uuid,text,text,boolean,integer,text,text,timestamptz,uuid,text)','execute')
    and has_function_privilege('service_role','operator_save_product(uuid,uuid,text,text,text,boolean,timestamptz,uuid,text)','execute'),
    'catalogue entry points are service-only');
  raise notice 'OK: catalogue grants/pause, product and retailer create/edit, duplicate/stale/synced-sku/fixed-currency refusals, audit and role probes';
end $$;
