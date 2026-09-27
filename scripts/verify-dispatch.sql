-- Synthetic DATA-01 boundary probes. Run only after migrations in a disposable DB.
create function pg_temp.assert_ok(p_ok boolean, p_message text) returns void language plpgsql as $$
begin if p_ok is distinct from true then raise exception 'ASSERT DATA-01: %', p_message; end if; end $$;
create function pg_temp.must_fail(p_sql text, p_pattern text) returns void language plpgsql as $$
begin
  begin execute p_sql;
  exception when others then
    if sqlerrm not like p_pattern then raise; end if;
    return;
  end;
  raise exception 'ASSERT DATA-01: expected rejection: %', p_pattern;
end $$;
create function pg_temp.fulfillment(p_id text, p_qty int default 40, p_order text default '900',
  p_status text default 'success', p_revision text default '2026-09-01T00:00:00Z', p_line text default '901')
returns jsonb language sql as $$
  select jsonb_build_object('id', p_id, 'order_id', p_order, 'status', p_status,
    'location_id', '10', 'updated_at', to_char(p_revision::timestamptz at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
    'line_items', jsonb_build_array(jsonb_build_object('id', p_line, 'quantity', p_qty)))
$$;

insert into orgs(id, slug, display_name) values
  ('10000000-0000-4000-8000-000000000001', 'dispatch-fixture-a', 'Synthetic A'),
  ('10000000-0000-4000-8000-000000000002', 'dispatch-fixture-b', 'Synthetic B');
insert into shopify_orders(org_id, shopify_order_id, currency, subtotal_cents, total_cents, raw)
  select id, '900', 'NZD', 0, 0, '{}' from orgs where slug like 'dispatch-fixture-%';
insert into shopify_order_lines(org_id, shopify_order_id, shopify_line_id, sku, quantity, unit_price_cents, total_cents, raw)
  select org_id, id, '901', 'SAME-SKU', 100, 0, 0, '{}' from shopify_orders where shopify_order_id = '900';
insert into shopify_order_lines(org_id, shopify_order_id, shopify_line_id, sku, quantity, unit_price_cents, total_cents, raw)
  select org_id, id, '902', 'SAME-SKU', 100, 0, 0, '{}' from shopify_orders where shopify_order_id = '900';
insert into shopify_order_lines(org_id, shopify_order_id, shopify_line_id, sku, quantity, unit_price_cents, total_cents, raw)
  select org_id, id, '903', null, 10, 0, 0, '{}' from shopify_orders where shopify_order_id = '900';

do $$
declare
  a uuid := '10000000-0000-4000-8000-000000000001';
  b uuid := '10000000-0000-4000-8000-000000000002';
  s uuid; sb uuid; alt uuid; d1 uuid; d2 uuid; d3 uuid; other uuid; p1 uuid; p2 uuid;
  line_id uuid; oid uuid; original_id uuid; event_id uuid; payload jsonb; status text; qty int; i int := 0;
  rev timestamptz := '2026-09-01T00:00:00Z';
begin
  d1 := project_shopify_dispatch(a, 'fixture-a.myshopify.com', pg_temp.fulfillment('1001', 40));
  d2 := project_shopify_dispatch(a, 'fixture-a.myshopify.com', pg_temp.fulfillment('1002', 60));
  select source_id into s from dispatches where id = d1;
  select id into line_id from dispatch_lines where dispatch_id = d1;
  perform pg_temp.assert_ok((select quantity = 40 from dispatch_lines where dispatch_id = d1), 'first dispatch uses 40');
  perform pg_temp.assert_ok((select quantity = 60 from dispatch_lines where dispatch_id = d2), 'second dispatch uses 60');
  perform pg_temp.assert_ok(project_shopify_dispatch(a, 'fixture-a.myshopify.com', pg_temp.fulfillment('1001', 40)) = d1,
    'repeated webhook/sync preserves dispatch identity');
  perform pg_temp.assert_ok((select id = line_id from dispatch_lines where dispatch_id = d1), 'line identity survives replay');
  perform pg_temp.assert_ok((select count(*) = 1 from dispatch_revisions where dispatch_id = d1), 'exact evidence deduplicates');
  p1 := claim_dispatch(a, s, d1, rev, 'part-A');
  p2 := claim_dispatch(a, s, d2, rev, 'part-B');
  perform pg_temp.assert_ok(p1 <> p2 and p1 = claim_dispatch(a, s, d1, rev, 'part-A'), 'distinct parts and stable retry');
  perform pg_temp.assert_ok((select sum(quantity) = 100 and count(*) = 2 from dispatch_allocations where source_id = s),
    '40/60 allocations total 100 exactly once');
  perform pg_temp.must_fail(format('select claim_dispatch(%L,%L,%L,%L,%L)', a,s,d1,rev,'other-key'), '%already allocated%');

  -- Same SKU retains both original order-line identities, without price/quantity grouping.
  payload := pg_temp.fulfillment('1003', 10) || jsonb_build_object('line_items', jsonb_build_array(
    jsonb_build_object('id','901','quantity',10), jsonb_build_object('id','902','quantity',15)));
  d3 := project_shopify_dispatch(a, 'fixture-a.myshopify.com', payload);
  perform pg_temp.assert_ok((select count(distinct order_line_key) = 2 and count(distinct item_key) = 1
    from dispatch_lines where dispatch_id = d3 and active), 'same SKU does not collapse original lines');
  perform pg_temp.must_fail(format('select claim_dispatch(%L,%L,%L,%L,%L)', a,s,d3,rev,'over-order'), '%exceeds original order%');
  perform pg_temp.assert_ok((select count(*) = 0 from dispatch_invoice_parts where dispatch_id = d3), 'failed bound creates no part');

  -- A different business may use exactly the same source IDs/SKUs without collision.
  other := project_shopify_dispatch(b, 'fixture-b.myshopify.com', pg_temp.fulfillment('1001', 40));
  select source_id into sb from dispatches where id = other;
  perform pg_temp.assert_ok(other <> d1 and sb <> s, 'business/source identities are distinct');
  perform claim_dispatch(b, sb, other, rev, 'part-A');
  perform pg_temp.must_fail(format('select claim_dispatch(%L,%L,%L,%L,%L)', b,s,d1,rev,'part-A'), '%not available%');
  perform pg_temp.must_fail(format('select claim_dispatch(%L,%L,%L,%L,%L)', a,sb,d1,rev,'part-A'), '%not available%');
  perform pg_temp.must_fail(format('select project_dispatch(%L,%L,%L,%L,%L,%L,null,%L,null,%L)',
    b,s,'x','order',rev,'succeeded','[]','{}'), '%not available%');
  perform pg_temp.must_fail(format('select bind_shopify_dispatch_source(%L,%L)', a,'replacement.myshopify.com'), '%binding mismatch%');

  -- Missing order/line is a recoverable projection error, not a fabricated mapping.
  perform pg_temp.must_fail(format('select project_shopify_dispatch(%L,%L,%L)', a,'fixture-a.myshopify.com',
    pg_temp.fulfillment('1004', 5, '999')), '%order not yet synced%');
  insert into shopify_orders(org_id, shopify_order_id, currency, subtotal_cents, total_cents, raw)
    values (a,'999','NZD',0,0,'{}') returning id into oid;
  perform pg_temp.must_fail(format('select project_shopify_dispatch(%L,%L,%L)', a,'fixture-a.myshopify.com',
    pg_temp.fulfillment('1004', 5, '999')), '%order line not yet synced%');
  insert into shopify_order_lines(org_id, shopify_order_id, shopify_line_id, sku, quantity, unit_price_cents, total_cents, raw)
    values (a,oid,'901','LATE',100,0,0,'{}');
  other := project_shopify_dispatch(a, 'fixture-a.myshopify.com', pg_temp.fulfillment('1004', 5, '999'));
  perform pg_temp.assert_ok(other = project_shopify_dispatch(a, 'fixture-a.myshopify.com', pg_temp.fulfillment('1004', 5, '999')),
    'late source recovery converges');

  -- Invalid inputs retain evidence but expose no eligible subset.
  foreach status in array array['cancelled','pending','open','failure','error','unrecognized'] loop
    i := i + 1;
    other := project_shopify_dispatch(a, 'fixture-a.myshopify.com', pg_temp.fulfillment((2000+i)::text, 5, '999', status));
    perform pg_temp.assert_ok((select state <> 'eligible' from dispatches where id = other), 'status cannot allocate: ' || status);
    perform pg_temp.must_fail(format('select claim_dispatch(%L,%L,%L,%L,%L)', a,s,other,rev,'status-'||status), '%not eligible%');
  end loop;
  foreach qty in array array[0,-1,101] loop
    other := project_shopify_dispatch(a, 'fixture-a.myshopify.com', pg_temp.fulfillment('3' || abs(qty)::text, qty));
    perform pg_temp.assert_ok((select state = 'blocked' and reason is not null from dispatches where id = other), 'invalid quantity visible');
    perform pg_temp.assert_ok((select count(*) = 0 from dispatch_lines where dispatch_id = other and active), 'no partial eligible lines');
  end loop;
  other := project_shopify_dispatch(a, 'fixture-a.myshopify.com', pg_temp.fulfillment('4001', 5, '900', 'success', rev::text, '903'));
  perform pg_temp.assert_ok((select reason = 'missing_item_mapping' from dispatches where id = other), 'no-SKU line is blocked, not skipped');
  payload := pg_temp.fulfillment('4002', 5) - 'line_items';
  other := project_shopify_dispatch(a, 'fixture-a.myshopify.com', payload);
  perform pg_temp.assert_ok((select state = 'blocked' from dispatches where id = other), 'missing lines blocked');
  payload := pg_temp.fulfillment('4003', 5) || '{"line_items":[{"id":"901","quantity":5},{"id":"901","quantity":5}]}'::jsonb;
  other := project_shopify_dispatch(a, 'fixture-a.myshopify.com', payload);
  perform pg_temp.assert_ok((select reason = 'duplicate_source_line' from dispatches where id = other), 'duplicate line blocked');
  perform pg_temp.must_fail(format('select project_shopify_dispatch(%L,%L,%L)', a,'fixture-a.myshopify.com',
    pg_temp.fulfillment('4004',5) - 'updated_at'), '%updated_at with timezone%');

  -- Newer revisions update stable current lines; older revisions are only history.
  other := project_shopify_dispatch(a, 'fixture-a.myshopify.com', pg_temp.fulfillment('5001',10,'999','success','2026-09-02T00:00:00Z'));
  select id into original_id from dispatch_lines where dispatch_id = other;
  perform project_shopify_dispatch(a, 'fixture-a.myshopify.com', pg_temp.fulfillment('5001',20,'999','success','2026-09-03T00:00:00Z'));
  perform project_shopify_dispatch(a, 'fixture-a.myshopify.com', pg_temp.fulfillment('5001',5,'999'));
  perform pg_temp.assert_ok((select quantity = 20 and id = original_id from dispatch_lines where dispatch_id = other), 'stale update rejected');
  perform pg_temp.assert_ok((select raw->'line_items'->0->>'quantity' = '20' from shopify_fulfillments where dispatch_id = other),
    'legacy header also rejects stale updates');
  perform project_shopify_dispatch(a, 'fixture-a.myshopify.com', pg_temp.fulfillment('5001',21,'999','success','2026-09-03T00:00:00Z'));
  perform pg_temp.assert_ok((select reason = 'conflicting_source_revision' from dispatches where id = other), 'same-revision conflict visible');
  perform project_shopify_dispatch(a, 'fixture-a.myshopify.com', pg_temp.fulfillment('5001',20,'999','success','2026-09-03T00:00:00Z'));
  perform pg_temp.assert_ok((select state = 'blocked' from dispatches where id = other), 'retry cannot clear a conflict');

  -- Cancellation after allocation preserves original history and quantities permanently.
  payload := pg_temp.fulfillment('1001',40,'900','cancelled','2026-09-04T00:00:00Z');
  perform project_shopify_dispatch(a, 'fixture-a.myshopify.com', payload);
  perform project_shopify_dispatch(a, 'fixture-a.myshopify.com', payload);
  perform pg_temp.assert_ok((select state = 'correction_required' from dispatches where id = d1), 'post-allocation correction visible');
  perform pg_temp.assert_ok((select count(*) = 1 from dispatch_corrections where dispatch_id = d1), 'correction retry deduplicates');
  perform pg_temp.assert_ok((select quantity = 40 from dispatch_allocations where part_id = p1), 'allocated quantity not freed');
  perform pg_temp.must_fail(format('select claim_dispatch(%L,%L,%L,%L,%L)', a,s,d1,'2026-09-04T00:00:00Z','part-A'), '%not eligible%');
  perform pg_temp.must_fail(format('delete from dispatch_allocations where part_id=%L',p1), '%append-only%');
  perform pg_temp.must_fail(format('update dispatch_invoice_parts set claim_key=%L where id=%L','tamper',p1), '%append-only%');

  -- A failed surrounding transaction owns normalization/claims: no half-written rows.
  begin
    other := project_shopify_dispatch(a, 'fixture-a.myshopify.com', pg_temp.fulfillment('6001',5,'999'));
    perform claim_dispatch(a,s,other,rev,'rollback');
    raise exception 'fixture abort';
  exception when raise_exception then if sqlerrm <> 'fixture abort' then raise; end if; end;
  perform pg_temp.assert_ok(not exists(select 1 from dispatches where source_id=s and source_dispatch_key='6001'), 'rollback is atomic');
  other := project_shopify_dispatch(a, 'fixture-a.myshopify.com', pg_temp.fulfillment('6001',5,'999'));
  perform claim_dispatch(a,s,other,rev,'rollback');

  -- Historical invoices are not silently made available for a second allocation.
  other := project_shopify_dispatch(a, 'fixture-a.myshopify.com', pg_temp.fulfillment('8001',5,'999'));
  insert into fulfillment_events(org_id,shopify_fulfillment_id,shopify_order_id,route,occurred_at)
    select a,id,shopify_order_id,'wholesale',rev from shopify_fulfillments where dispatch_id=other
    returning id into event_id;
  insert into invoices(org_id,invoice_number,state,currency,subtotal_cents,total_cents,fulfillment_event_id)
    values(a,'SYNTHETIC-LEGACY','issued','NZD',0,0,event_id);
  perform project_shopify_dispatch(a, 'fixture-a.myshopify.com',
    pg_temp.fulfillment('8001',5,'999','success','2026-09-02T00:00:00Z'));
  perform pg_temp.assert_ok((select reason='legacy_invoice_requires_reconciliation' from dispatches where id=other),
    'legacy invoice creates a reconciliation block');
  perform pg_temp.must_fail(format('select claim_dispatch(%L,%L,%L,%L,%L)', a,s,other,'2026-09-02T00:00:00Z','legacy'), '%not eligible%');

  -- Another provider uses the same Atlas contract without any Shopify rows or fake IDs.
  insert into dispatch_sources(org_id, provider, connection_key) values (b,'warehouse','fixture-warehouse') returning id into alt;
  payload := '[{"source_line_key":"dispatch-line","order_line_key":"order-line","item_key":"widget","quantity":7,"ordered_quantity":7}]';
  other := project_dispatch(b,alt,'shipment','warehouse-order',rev,'succeeded',null,payload,null,'{}');
  perform claim_dispatch(b,alt,other,rev,'warehouse-part');
  perform pg_temp.assert_ok((select quantity=7 from dispatch_allocations where dispatch_id=other), 'provider-neutral contract');
end $$;

-- Authorization is tested with actual database roles, not owner-only calls.
select pg_temp.assert_ok(not has_table_privilege('service_role','dispatch_allocations','INSERT'), 'service cannot insert allocations');
select pg_temp.assert_ok(not has_table_privilege('service_role','dispatch_lines','UPDATE'), 'service cannot alter allocated lines');
select pg_temp.assert_ok(not has_function_privilege('authenticated',
  'claim_dispatch(uuid,uuid,uuid,timestamp with time zone,text)','EXECUTE'), 'browser cannot self-select claim business');
select pg_temp.assert_ok(not has_function_privilege('anon',
  'project_shopify_dispatch(uuid,text,jsonb)','EXECUTE'), 'anonymous projection denied');
set role service_role;
select project_shopify_dispatch('10000000-0000-4000-8000-000000000001','fixture-a.myshopify.com',
  '{"id":"7001","order_id":"999","status":"success","updated_at":"2026-09-01T00:00:00Z","line_items":[{"id":"901","quantity":1}]}');
reset role;
select pg_temp.assert_ok((select state='eligible' from dispatches where source_dispatch_key='7001'), 'service RPC can project');
\echo 'OK - DATA-01 dispatch quantities, revisions, recovery, allocation and role probes'
