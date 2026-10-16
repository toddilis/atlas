-- JOBS-01 probes on the disposable database: carrier cost job discovery, leases, outcomes,
-- crash recovery and quarantine. Self-contained synthetic business.
create function pg_temp.jobs_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT JOBS: %',msg; end if; end $$;
create function pg_temp.jobs_reject(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like pattern then raise; end if; return; end;
  raise exception 'ASSERT JOBS expected rejection: %',pattern;
end $$;
do $$
declare
  company uuid:='67000000-0000-4000-8000-000000000001'; account uuid:='67000000-0000-4000-8000-000000000002';
  source uuid; v uuid; rev timestamptz:='2026-10-02T09:00:00+13:00'; o uuid; d uuid; a1 uuid; a2 uuid; d0 uuid; part uuid; inv uuid;
  j1 scheduled_jobs; j2 scheduled_jobs; j scheduled_jobs; k text;
  line jsonb:='[{"source_line_key":"1","order_line_key":"1","item_key":"WIDGET","quantity":1,"ordered_quantity":2}]';
begin
  insert into orgs(id,slug,display_name) values(company,'jobs-fixture','Synthetic jobs');
  insert into accounts(id,org_id,name) values(account,company,'Synthetic retailer');
  insert into shopify_customers(org_id,shopify_customer_id,raw,account_id) values(company,'cust','{}',account);
  source:=bind_shopify_dispatch_source(company,'jobs-fixture.myshopify.com');
  v:=save_pricing_version(company,0,jsonb_build_object('schemaVersion',1,'businessId',company,'version','v1'),'fixture','jobs fixture');
  -- order key -> its dispatches as (dispatch key, tracking numbers)
  foreach k in array array['first','untracked','costed','billed'] loop
    insert into shopify_orders(org_id,shopify_order_id,shopify_customer_id,currency,subtotal_cents,total_cents,raw,placed_at)
      values(company,k,'cust','NZD',0,0,'{}',rev) returning id into o;
    foreach d in array case when k in ('first','billed') then array[gen_random_uuid(),gen_random_uuid()] else array[gen_random_uuid()] end loop
      d:=project_dispatch(company,source,k||'-'||d::text,o::text,rev,'succeeded',null,line,null,'{}',rev);
      insert into shopify_fulfillments(org_id,shopify_fulfillment_id,shopify_order_id,status,tracking_numbers,raw,occurred_at,dispatch_id)
        values(company,(select source_dispatch_key from dispatches where id=d),o,'success',
          case when k='untracked' then '{}'::text[] else array['SYN-'||left(d::text,8)] end,'{}',rev,d);
      if k='first' then if a1 is null then a1:=d; else a2:=d; end if; end if;
      if k='costed' then perform record_carrier_cost(company,source,d,'gosweetspot:synthetic','q-'||d,'NZD',1000,rev,'2099-01-01T00:00:00Z','{}'); end if;
      if k='billed' and d0 is null then
        d0:=d; part:=claim_dispatch(company,source,d,rev,'bill:'||d);
        insert into invoices(org_id,account_id,invoice_number,state,currency,subtotal_cents,tax_cents,total_cents)
          values(company,account,'JOB-1A','draft','NZD',0,0,0) returning id into inv;
        insert into invoice_calculation_snapshots(org_id,invoice_id,part_id,source_id,dispatch_id,source_revision,pricing_version_id,snapshot,content_hash,document)
          values(company,inv,part,source,d,rev,v,'{}','x','{}');
      end if;
    end loop;
  end loop;

  -- Discovery: only the unbilled order's first-part candidates with tracking and no valid cost.
  perform pg_temp.jobs_assert(discover_carrier_cost_jobs(company)=2,'discovers the two candidates of the unbilled order');
  perform pg_temp.jobs_assert((select array_agg(dispatch_id order by dispatch_id) from scheduled_jobs where org_id=company)
    =(select array_agg(x order by x) from unnest(array[a1,a2]) x),'only unbilled, tracked, uncosted dispatches');
  perform pg_temp.jobs_assert(discover_carrier_cost_jobs(company)=0,'discovery is idempotent');

  -- Leases: each claim takes a different due job; nothing else is due.
  j1:=claim_scheduled_job(company,'carrier_cost_sync'); j2:=claim_scheduled_job(company,'carrier_cost_sync');
  perform pg_temp.jobs_assert(j1.job_key<>j2.job_key and j1.state='running' and j1.attempts=1 and j1.lease_token is not null,'two distinct leases');
  perform pg_temp.jobs_assert((claim_scheduled_job(company,'carrier_cost_sync')).job_key is null,'no third due job');
  perform pg_temp.jobs_reject(format('select finish_scheduled_job(%L,%L,%L,%L,%L)',company,j1.job_key,gen_random_uuid(),'succeeded','{}'),'%%stale job lease%%');
  perform pg_temp.jobs_reject(format('select finish_scheduled_job(%L,%L,%L,%L,%L)',company,j1.job_key,j1.lease_token,'done','{}'),'%%unknown job outcome%%');

  -- Outcomes: retry backs off, blocked shows its reason, both are recorded runs.
  perform pg_temp.jobs_assert(finish_scheduled_job(company,j1.job_key,j1.lease_token,'retry','{"error":"HTTP 503"}')='failed','retry leaves the job failed');
  perform pg_temp.jobs_assert(finish_scheduled_job(company,j2.job_key,j2.lease_token,'blocked','{"error":"GOSWEETSPOT_SITE_ID must be set"}')='blocked','blocked');
  perform pg_temp.jobs_assert((select next_attempt_at>now() and last_error='HTTP 503' from scheduled_jobs where org_id=company and job_key=j1.job_key),'retry backs off');
  perform pg_temp.jobs_assert((select next_attempt_at>=now()+interval '6 hours' and last_error like 'GOSWEETSPOT_SITE_ID%' from scheduled_jobs where org_id=company and job_key=j2.job_key),'blocked reason visible');
  perform pg_temp.jobs_assert((claim_scheduled_job(company,'carrier_cost_sync')).job_key is null,'nothing due during backoff');
  perform pg_temp.jobs_reject(format('select finish_scheduled_job(%L,%L,%L,%L,%L)',company,j1.job_key,j1.lease_token,'succeeded','{}'),'%%stale job lease%%');

  -- Crash recovery: an expired lease is recorded and the job is claimed again.
  update scheduled_jobs set next_attempt_at=now()-interval '1 minute' where org_id=company and job_key=j1.job_key;
  j:=claim_scheduled_job(company,'carrier_cost_sync');
  update scheduled_jobs set lease_until=clock_timestamp()-interval '1 second' where org_id=company and job_key=j.job_key;
  j:=claim_scheduled_job(company,'carrier_cost_sync');
  perform pg_temp.jobs_assert(j.job_key=j1.job_key and j.attempts=3,'expired lease reclaimed');
  perform pg_temp.jobs_assert((select count(*)=1 from job_runs where org_id=company and job_key=j1.job_key and outcome='lease_expired'),'expired lease recorded');
  perform pg_temp.jobs_assert(finish_scheduled_job(company,j.job_key,j.lease_token,'succeeded','{"cost_minor":"1000"}')='succeeded','recovered run succeeds');

  -- Quarantine after the attempt limit.
  update scheduled_jobs set attempts=7,next_attempt_at=now()-interval '1 minute' where org_id=company and job_key=j2.job_key;
  j:=claim_scheduled_job(company,'carrier_cost_sync');
  perform pg_temp.jobs_assert(finish_scheduled_job(company,j.job_key,j.lease_token,'retry','{"error":"HTTP 503"}')='quarantined','quarantined at the limit');
  perform pg_temp.jobs_assert((claim_scheduled_job(company,'carrier_cost_sync')).job_key is null,'quarantined jobs are not claimed');

  -- A succeeded job with no valid recorded cost (here: none was recorded) is re-armed while unbilled.
  perform pg_temp.jobs_assert(discover_carrier_cost_jobs(company)=1,'re-arms the succeeded job');
  perform pg_temp.jobs_assert((select state='pending' and attempts=0 from scheduled_jobs where org_id=company and job_key=j1.job_key),'re-armed as pending');
  perform pg_temp.jobs_reject(format('update job_runs set outcome=%L where org_id=%L','succeeded',company),'%%append-only%%');
  perform pg_temp.jobs_assert(not has_function_privilege('anon','claim_scheduled_job(uuid,text)','execute')
    and has_function_privilege('service_role','claim_scheduled_job(uuid,text)','execute'),'job functions are service-only');
end $$;

-- Operator retry (0030): entitlement, pause, identity, reason, stale view, state and current
-- preconditions are enforced in the database; each retry is recorded in job_runs and audit_log.
do $$
declare
  company uuid:='67000000-0000-4000-8000-000000000001'; actor uuid:='67000000-0000-4000-8000-0000000000aa';
  j scheduled_jobs; p scheduled_jobs; call text;
begin
  select * into j from scheduled_jobs where org_id=company and state='quarantined';
  call:=format('select retry_scheduled_job(%L,%L,%L,%L,%L,%L)',company,j.job_key,j.updated_at,actor,'ops@example.test','site id fixed');
  perform pg_temp.jobs_reject(call,'%%tool entitlement missing or revoked%%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','jobs.retry','notify');
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.jobs_reject(call,'%%business actions paused%%');
  perform set_action_pause(company,false,'probe','probe resume');
  perform pg_temp.jobs_reject(format('select retry_scheduled_job(%L,%L,%L,%L,%L,%L)',company,j.job_key,j.updated_at,actor,'ops@example.test',' '),'%%retry reason required%%');
  perform pg_temp.jobs_reject(format('select retry_scheduled_job(%L,%L,%L,%L,%L,%L)',company,j.job_key,j.updated_at,null,'ops@example.test','fixed'),'%%operator identity required%%');
  perform pg_temp.jobs_reject(format('select retry_scheduled_job(%L,%L,%L,%L,%L,%L)',company,j.job_key,j.updated_at-interval '1 second',actor,'ops@example.test','fixed'),'%%job changed since it was loaded%%');
  perform pg_temp.jobs_reject(format('select retry_scheduled_job(%L,%L,%L,%L,%L,%L)',company,'carrier-cost:none',j.updated_at,actor,'ops@example.test','fixed'),'%%job not found%%');

  perform pg_temp.jobs_assert(retry_scheduled_job(company,j.job_key,j.updated_at,actor,'ops@example.test','  site id fixed ')='pending','retry accepted');
  perform pg_temp.jobs_assert((select state='pending' and attempts=0 and last_error is null and next_attempt_at<=now() from scheduled_jobs where org_id=company and job_key=j.job_key),'job pending again from attempt 1');
  perform pg_temp.jobs_assert((select count(*)=1 from job_runs where org_id=company and job_key=j.job_key and outcome='operator_retry'
    and detail->>'reason'='site id fixed' and detail->>'actor_email'='ops@example.test' and detail->>'previous_state'='quarantined'),'retry recorded in job history');
  perform pg_temp.jobs_assert((select count(*)=1 from audit_log where org_id=company and action='jobs.retry' and outcome='success'
    and detail->>'job_key'=j.job_key and detail->>'actor_id'=actor::text and (detail->>'previous_attempts')::int=8),'retry audited');
  perform pg_temp.jobs_reject(call,'%%job changed since it was loaded%%');
  select * into p from scheduled_jobs where org_id=company and job_key=j.job_key;
  perform pg_temp.jobs_reject(format('select retry_scheduled_job(%L,%L,%L,%L,%L,%L)',company,p.job_key,p.updated_at,actor,'ops@example.test','again'),'%%only blocked, quarantined or dismissed%%');

  -- A blocked job whose dispatch has since been costed is refused, not re-run.
  select * into p from scheduled_jobs where org_id=company and job_key<>j.job_key and dispatch_id in (select dispatch_id from scheduled_jobs where org_id=company) limit 1;
  update scheduled_jobs set state='blocked',last_error='GOSWEETSPOT_SITE_ID must be set' where org_id=company and job_key=p.job_key returning * into p;
  perform record_carrier_cost(company,p.source_id,p.dispatch_id,'gosweetspot:synthetic','q-retry-'||p.dispatch_id,'NZD',900,now(),'2099-01-01T00:00:00Z','{}');
  perform pg_temp.jobs_reject(format('select retry_scheduled_job(%L,%L,%L,%L,%L,%L)',company,p.job_key,p.updated_at,actor,'ops@example.test','fixed'),'%%job no longer needed%%');

  update tool_grants set enabled=false where org_id=company and agent_name='operator' and tool_name='jobs.retry';
  perform pg_temp.jobs_reject(format('select retry_scheduled_job(%L,%L,%L,%L,%L,%L)',company,p.job_key,p.updated_at,actor,'ops@example.test','fixed'),'%%tool entitlement missing or revoked%%');
  perform pg_temp.jobs_assert(not has_function_privilege('authenticated','retry_scheduled_job(uuid,text,timestamptz,uuid,text,text)','execute')
    and has_function_privilege('service_role','retry_scheduled_job(uuid,text,timestamptz,uuid,text,text)','execute'),'retry is service-only');
end $$;

-- Operator dismissal (0031): never claimed or re-armed, records no cost, undone by retry.
do $$
declare
  company uuid:='67000000-0000-4000-8000-000000000001'; actor uuid:='67000000-0000-4000-8000-0000000000aa';
  j scheduled_jobs; c scheduled_jobs; n int:=0;
begin
  select * into j from scheduled_jobs where org_id=company and job_key=(select job_key from job_runs where org_id=company and outcome='operator_retry' limit 1);
  perform pg_temp.jobs_reject(format('select dismiss_scheduled_job(%L,%L,%L,%L,%L,%L)',company,j.job_key,j.updated_at,actor,'ops@example.test','not ours'),'%%tool entitlement missing or revoked%%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','jobs.dismiss','notify');
  perform pg_temp.jobs_reject(format('select dismiss_scheduled_job(%L,%L,%L,%L,%L,%L)',company,j.job_key,j.updated_at,actor,'ops@example.test','not ours'),'%%only blocked or quarantined jobs can be dismissed%%');
  update scheduled_jobs set state='blocked',attempts=3,last_error='gosweetspot: response does not cover every tracking number of the dispatch'
    where org_id=company and job_key=j.job_key returning * into j;
  perform pg_temp.jobs_reject(format('select dismiss_scheduled_job(%L,%L,%L,%L,%L,%L)',company,j.job_key,j.updated_at,actor,'ops@example.test','no'),'%%dismiss reason required%%');
  perform pg_temp.jobs_reject(format('select dismiss_scheduled_job(%L,%L,%L,%L,%L,%L)',company,j.job_key,j.updated_at-interval '1 second',actor,'ops@example.test','not ours'),'%%job changed since it was loaded%%');
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.jobs_reject(format('select dismiss_scheduled_job(%L,%L,%L,%L,%L,%L)',company,j.job_key,j.updated_at,actor,'ops@example.test','not ours'),'%%business actions paused%%');
  perform set_action_pause(company,false,'probe','probe resume');

  perform pg_temp.jobs_assert(dismiss_scheduled_job(company,j.job_key,j.updated_at,actor,'ops@example.test',' Sent by hand courier ')='dismissed','dismissed');
  perform pg_temp.jobs_assert((select state='dismissed' and last_error like 'gosweetspot:%' from scheduled_jobs where org_id=company and job_key=j.job_key),'reason kept with the dismissed job');
  perform pg_temp.jobs_assert((select count(*)=1 from job_runs where org_id=company and job_key=j.job_key and outcome='operator_dismiss'
    and detail->>'reason'='Sent by hand courier' and detail->>'previous_state'='blocked'),'dismissal in job history');
  perform pg_temp.jobs_assert((select count(*)=1 from audit_log where org_id=company and action='jobs.dismiss' and detail->>'job_key'=j.job_key
    and detail->>'actor_email'='ops@example.test' and (detail->>'previous_attempts')::int=3),'dismissal audited');
  -- Never claimed, never re-armed by discovery, and no carrier cost was recorded.
  update scheduled_jobs set next_attempt_at=now()-interval '1 day' where org_id=company and job_key=j.job_key returning * into j;
  loop
    c:=claim_scheduled_job(company,'carrier_cost_sync'); exit when c.job_key is null;
    perform pg_temp.jobs_assert(c.job_key<>j.job_key,'dismissed job is never claimed');
    perform finish_scheduled_job(company,c.job_key,c.lease_token,'blocked','{"error":"probe"}');
    n:=n+1; exit when n>10;
  end loop;
  perform discover_carrier_cost_jobs(company);
  perform pg_temp.jobs_assert((select state='dismissed' from scheduled_jobs where org_id=company and job_key=j.job_key),'discovery does not re-arm a dismissal');
  perform pg_temp.jobs_assert(not exists(select 1 from carrier_cost_evidence where org_id=company and dispatch_id=j.dispatch_id),'dismissal records no cost');
  -- Undo: retry brings it back from dismissed (the retry grant was revoked above).
  update tool_grants set enabled=true where org_id=company and agent_name='operator' and tool_name='jobs.retry';
  perform pg_temp.jobs_assert(retry_scheduled_job(company,j.job_key,j.updated_at,actor,'ops@example.test','was booked after all')='pending','retry undoes dismissal');
  perform pg_temp.jobs_assert((select count(*)=1 from job_runs where org_id=company and job_key=j.job_key and outcome='operator_retry' and detail->>'previous_state'='dismissed'),'undo recorded');
  perform pg_temp.jobs_assert(not has_function_privilege('authenticated','dismiss_scheduled_job(uuid,text,timestamptz,uuid,text,text)','execute')
    and has_function_privilege('service_role','dismiss_scheduled_job(uuid,text,timestamptz,uuid,text,text)','execute'),'dismiss is service-only');
end $$;

-- Manual carrier cost (0032): grant (not seeded), pause, amount format, stale view, only
-- dismissed jobs, still needed; stored as manual carrier evidence with full attribution.
do $$
declare
  company uuid:='67000000-0000-4000-8000-000000000001'; actor uuid:='67000000-0000-4000-8000-0000000000aa';
  j scheduled_jobs; p scheduled_jobs; ev carrier_cost_evidence; v uuid; amount text;
begin
  select * into j from scheduled_jobs where org_id=company and job_key=(select job_key from job_runs where org_id=company and outcome='operator_dismiss' limit 1);
  update scheduled_jobs set state='dismissed' where org_id=company and job_key=j.job_key returning * into j;
  perform pg_temp.jobs_assert(not exists(select 1 from carrier_cost_evidence where org_id=company and dispatch_id=j.dispatch_id),'fixture dispatch has no cost yet');
  perform pg_temp.jobs_reject(format('select record_manual_carrier_cost(%L,%L,%L,%L,%L,%L,%L,%L)',company,j.job_key,j.updated_at,actor,'ops@example.test','hand courier','12.50',null),'%%tool entitlement missing or revoked%%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','carriers.record_manual_cost','notify');
  foreach amount in array array['12.345','-1','1,50','abc','','1e3','.5','1234567890'] loop
    perform pg_temp.jobs_reject(format('select record_manual_carrier_cost(%L,%L,%L,%L,%L,%L,%L,%L)',company,j.job_key,j.updated_at,actor,'ops@example.test','hand courier',amount,null),'%%at most two decimals%%');
  end loop;
  perform pg_temp.jobs_reject(format('select record_manual_carrier_cost(%L,%L,%L,%L,%L,%L,%L,%L)',company,j.job_key,j.updated_at,actor,'ops@example.test','x','12.50',null),'%%cost reason required%%');
  perform pg_temp.jobs_reject(format('select record_manual_carrier_cost(%L,%L,%L,%L,%L,%L,%L,%L)',company,j.job_key,j.updated_at-interval '1 second',actor,'ops@example.test','hand courier','12.50',null),'%%job changed since it was loaded%%');
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.jobs_reject(format('select record_manual_carrier_cost(%L,%L,%L,%L,%L,%L,%L,%L)',company,j.job_key,j.updated_at,actor,'ops@example.test','hand courier','12.50',null),'%%business actions paused%%');
  perform set_action_pause(company,false,'probe','probe resume');
  select * into p from scheduled_jobs where org_id=company and state<>'dismissed' limit 1;
  perform pg_temp.jobs_reject(format('select record_manual_carrier_cost(%L,%L,%L,%L,%L,%L,%L,%L)',company,p.job_key,p.updated_at,actor,'ops@example.test','hand courier','12.50',null),'%%only dismissed jobs%%');

  v:=record_manual_carrier_cost(company,j.job_key,j.updated_at,actor,'ops@example.test',' Hand courier, receipt in Xero ','12.50',' INV-778 ');
  select * into ev from carrier_cost_evidence where id=v;
  perform pg_temp.jobs_assert(ev.dispatch_id=j.dispatch_id and ev.cost_minor=1250 and ev.currency='NZD' and ev.tax_basis='exclusive'
    and ev.carrier_connection='manual:operator' and ev.expires_at=ev.observed_at+interval '365 days'
    and ev.evidence->>'reason'='Hand courier, receipt in Xero' and ev.evidence->>'reference'='INV-778'
    and ev.evidence#>>'{entered_by,email}'='ops@example.test','manual cost stored as attributable carrier evidence');
  perform pg_temp.jobs_assert((select id from carrier_cost_evidence where org_id=company and dispatch_id=j.dispatch_id order by observed_at desc,recorded_at desc limit 1)=v,
    'the draft would use the manual cost (latest evidence for the dispatch)');
  perform pg_temp.jobs_assert((select state='succeeded' from scheduled_jobs where org_id=company and job_key=j.job_key),'job resolved');
  perform pg_temp.jobs_assert((select count(*)=1 from job_runs where org_id=company and job_key=j.job_key and outcome='operator_cost'
    and detail->>'cost_minor'='1250' and detail->>'evidence_id'=v::text),'manual cost in job history');
  perform pg_temp.jobs_assert((select count(*)=1 from audit_log where org_id=company and action='carriers.record_manual_cost'
    and subject_id=j.dispatch_id and detail->>'cost_minor'='1250' and detail->>'actor_email'='ops@example.test'),'manual cost audited');
  perform pg_temp.jobs_reject(format('select record_manual_carrier_cost(%L,%L,%L,%L,%L,%L,%L,%L)',company,j.job_key,j.updated_at,actor,'ops@example.test','again','9.00',null),'%%job changed since it was loaded%%');
  perform discover_carrier_cost_jobs(company);
  perform pg_temp.jobs_assert((select state='succeeded' from scheduled_jobs where org_id=company and job_key=j.job_key),'a recorded manual cost is not re-synced');

  -- A dismissed job whose dispatch already has a cost is refused.
  select * into p from scheduled_jobs s where org_id=company and exists(select 1 from carrier_cost_evidence e where e.dispatch_id=s.dispatch_id and e.carrier_connection<>'manual:operator') limit 1;
  update scheduled_jobs set state='dismissed' where org_id=company and job_key=p.job_key returning * into p;
  perform pg_temp.jobs_reject(format('select record_manual_carrier_cost(%L,%L,%L,%L,%L,%L,%L,%L)',company,p.job_key,p.updated_at,actor,'ops@example.test','hand courier','5.00',null),'%%job no longer needed%%');
  perform pg_temp.jobs_assert(not has_function_privilege('authenticated','record_manual_carrier_cost(uuid,text,timestamptz,uuid,text,text,text,text)','execute')
    and has_function_privilege('service_role','record_manual_carrier_cost(uuid,text,timestamptz,uuid,text,text,text,text)','execute'),'manual cost is service-only');
end $$;

-- Pause, obsolete jobs, re-observation and grant tiers: a second synthetic business.
do $$
declare
  company uuid:='68000000-0000-4000-8000-000000000001'; account uuid:='68000000-0000-4000-8000-000000000002';
  actor uuid:='68000000-0000-4000-8000-0000000000aa'; other_job text;
  source uuid; v uuid; rev timestamptz:='2026-10-02T09:00:00+13:00'; o uuid; q uuid; d uuid; a uuid; b uuid; c uuid; part uuid; inv uuid;
  j scheduled_jobs; ev1 uuid; ev2 uuid;
  line jsonb:='[{"source_line_key":"1","order_line_key":"1","item_key":"WIDGET","quantity":1,"ordered_quantity":2}]';
begin
  insert into orgs(id,slug,display_name) values(company,'jobs-fixture-2','Synthetic jobs two');
  insert into accounts(id,org_id,name) values(account,company,'Synthetic retailer');
  insert into shopify_customers(org_id,shopify_customer_id,raw,account_id) values(company,'cust','{}',account);
  source:=bind_shopify_dispatch_source(company,'jobs-fixture-2.myshopify.com');
  v:=save_pricing_version(company,0,jsonb_build_object('schemaVersion',1,'businessId',company,'version','v1'),'fixture','jobs fixture');
  insert into shopify_orders(org_id,shopify_order_id,shopify_customer_id,currency,subtotal_cents,total_cents,raw,placed_at)
    values(company,'p','cust','NZD',0,0,'{}',rev) returning id into o;
  insert into shopify_orders(org_id,shopify_order_id,shopify_customer_id,currency,subtotal_cents,total_cents,raw,placed_at)
    values(company,'q','cust','NZD',0,0,'{}',rev) returning id into q;
  foreach d in array array[gen_random_uuid(),gen_random_uuid(),gen_random_uuid()] loop
    d:=project_dispatch(company,source,'p-'||d::text,(case when a is null or b is null then o else q end)::text,rev,'succeeded',null,line,null,'{}',rev);
    insert into shopify_fulfillments(org_id,shopify_fulfillment_id,shopify_order_id,status,tracking_numbers,raw,occurred_at,dispatch_id)
      values(company,(select source_dispatch_key from dispatches where id=d),(select order_key::uuid from dispatches where id=d),'success',array['SYN-'||left(d::text,8)],'{}',rev,d);
    if a is null then a:=d; elsif b is null then b:=d; else c:=d; end if;
  end loop;
  perform pg_temp.jobs_assert(discover_carrier_cost_jobs(company)=3,'three needed dispatches');

  -- Paused business actions stop the worker: nothing is claimed, so no carrier is called.
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.jobs_assert((claim_scheduled_job(company,'carrier_cost_sync')).job_key is null,'nothing claimed while paused');
  perform set_action_pause(company,false,'probe','probe resume');

  -- A due job whose dispatch has since been costed is closed on claim, not run.
  perform record_carrier_cost(company,source,a,'gosweetspot:synthetic','consignment:1@'||rev,'NZD',700,rev,'2099-01-01T00:00:00Z','{}');
  update scheduled_jobs set next_attempt_at=now()-interval '1 hour' where org_id=company and dispatch_id=a;
  update scheduled_jobs set next_attempt_at=now()+interval '1 hour' where org_id=company and dispatch_id<>a;
  perform pg_temp.jobs_assert((claim_scheduled_job(company,'carrier_cost_sync')).job_key is null,'an unneeded due job is not leased');
  perform pg_temp.jobs_assert((select state='succeeded' from scheduled_jobs where org_id=company and dispatch_id=a)
    and exists(select 1 from job_runs r join scheduled_jobs s using(org_id,job_key) where s.org_id=company and s.dispatch_id=a and r.outcome='not_needed'),
    'closed as no longer needed, with a recorded run');

  -- Stopped jobs whose work is gone are closed by discovery instead of waiting for a person:
  -- b's order is invoiced by its sibling, c's order (q) is invoiced.
  update scheduled_jobs set state='quarantined',attempts=8,last_error='HTTP 503' where org_id=company and dispatch_id=b;
  update scheduled_jobs set state='blocked',last_error='GOSWEETSPOT_SITE_ID must be set' where org_id=company and dispatch_id=c;
  part:=claim_dispatch(company,source,c,rev,'bill:'||c);
  insert into invoices(org_id,account_id,invoice_number,state,currency,subtotal_cents,tax_cents,total_cents)
    values(company,account,'JOB2-1A','draft','NZD',0,0,0) returning id into inv;
  insert into invoice_calculation_snapshots(org_id,invoice_id,part_id,source_id,dispatch_id,source_revision,pricing_version_id,snapshot,content_hash,document)
    values(company,inv,part,source,c,rev,v,'{}','x','{}');
  perform pg_temp.jobs_assert((select state='quarantined' from scheduled_jobs where org_id=company and dispatch_id=b),'b still needed before its order is billed');
  part:=claim_dispatch(company,source,a,rev,'bill:'||a);
  insert into invoices(org_id,account_id,invoice_number,state,currency,subtotal_cents,tax_cents,total_cents)
    values(company,account,'JOB2-2A','draft','NZD',0,0,0) returning id into inv;
  insert into invoice_calculation_snapshots(org_id,invoice_id,part_id,source_id,dispatch_id,source_revision,pricing_version_id,snapshot,content_hash,document)
    values(company,inv,part,source,a,rev,v,'{}','x','{}');
  perform discover_carrier_cost_jobs(company);
  perform pg_temp.jobs_assert((select count(*)=2 from scheduled_jobs s where org_id=company and dispatch_id in (b,c) and state='succeeded'
    and exists(select 1 from job_runs r where r.org_id=s.org_id and r.job_key=s.job_key and r.outcome='not_needed'
      and r.detail->>'previous_state' in ('quarantined','blocked'))),'quarantined and blocked jobs closed once their work is gone');
  perform pg_temp.jobs_assert(not has_function_privilege('service_role','close_unneeded_job(scheduled_jobs)','execute'),'closing is internal');

  -- A cost that expired before billing is observed again as new evidence, not a replay conflict.
  insert into shopify_orders(org_id,shopify_order_id,shopify_customer_id,currency,subtotal_cents,total_cents,raw,placed_at)
    values(company,'r','cust','NZD',0,0,'{}',rev) returning id into o;
  d:=project_dispatch(company,source,'r-1',o::text,rev,'succeeded',null,line,null,'{}',rev);
  insert into shopify_fulfillments(org_id,shopify_fulfillment_id,shopify_order_id,status,tracking_numbers,raw,occurred_at,dispatch_id)
    values(company,'r-1',o,'success',array['SYN-R1'],'{}',rev,d);
  ev1:=record_carrier_cost(company,source,d,'gosweetspot:synthetic','consignment:9@2026-09-01T00:00:00.000Z','NZD',800,'2026-09-01T00:00:00Z','2026-09-02T00:00:00Z','{}');
  perform pg_temp.jobs_assert(discover_carrier_cost_jobs(company)=1 and carrier_cost_job_needed(company,source,d),'expired cost makes the dispatch due again');
  ev2:=record_carrier_cost(company,source,d,'gosweetspot:synthetic','consignment:9@'||to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),'NZD',800,now(),now()+interval '30 days','{}');
  perform pg_temp.jobs_assert(ev1<>ev2 and not carrier_cost_job_needed(company,source,d)
    and (select id from carrier_cost_evidence where org_id=company and dispatch_id=d order by observed_at desc,recorded_at desc limit 1)=ev2,
    'the new observation is the latest evidence');

  -- Manual cost is refused when its grant is set to require approval (no approval step exists).
  select * into j from scheduled_jobs where org_id=company and dispatch_id=b;
  insert into shopify_orders(org_id,shopify_order_id,shopify_customer_id,currency,subtotal_cents,total_cents,raw,placed_at)
    values(company,'s','cust','NZD',0,0,'{}',rev) returning id into o;
  d:=project_dispatch(company,source,'s-1',o::text,rev,'succeeded',null,line,null,'{}',rev);
  insert into shopify_fulfillments(org_id,shopify_fulfillment_id,shopify_order_id,status,tracking_numbers,raw,occurred_at,dispatch_id)
    values(company,'s-1',o,'success',array['SYN-S1'],'{}',rev,d);
  perform discover_carrier_cost_jobs(company);
  update scheduled_jobs set state='dismissed' where org_id=company and dispatch_id=d returning * into j;
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','carriers.record_manual_cost','approve_required');
  perform pg_temp.jobs_reject(format('select record_manual_carrier_cost(%L,%L,%L,%L,%L,%L,%L,%L)',company,j.job_key,j.updated_at,actor,'ops@example.test','hand courier','12.50',null),
    '%%must not require approval%%');
  perform pg_temp.jobs_assert(not exists(select 1 from carrier_cost_evidence where org_id=company and dispatch_id=d),'refused manual cost records nothing');

  -- Another business's job key is not found under this business's authority.
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','jobs.retry','notify');
  select job_key into other_job from scheduled_jobs where org_id='67000000-0000-4000-8000-000000000001' limit 1;
  perform pg_temp.jobs_reject(format('select retry_scheduled_job(%L,%L,%L,%L,%L,%L)',company,other_job,now(),actor,'ops@example.test','not mine'),'%%job not found%%');
end $$;
