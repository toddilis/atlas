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
