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
