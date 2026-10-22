-- CONFIG-01c business profile (0045): grant/pause/identity enforcement, bounded trimmed
-- fields with empty meaning cleared, first-save and stale-edit rules, retry stability
-- without double audit, cross-business isolation and role privileges.
create function pg_temp.prof_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT PROFILE: %',msg; end if; end $$;
create function pg_temp.prof_reject(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like pattern then raise; end if; return; end;
  raise exception 'ASSERT PROFILE expected rejection: %',pattern;
end $$;
do $$
declare
  company uuid:='81000000-0000-4000-8000-000000000001'; operator uuid:='81000000-0000-4000-8000-0000000000aa';
  t timestamptz; save text;
begin
  insert into orgs(id,slug,display_name) values(company,'profile-fixture','Synthetic profile drill');
  save:=format('select operator_save_business_profile(%L,%L,%L,%L,%L,%L,null,%L,%L)',
    company,'Synthetic Fixtures Ltd','GST number','123-456-789',E'1 Example Street\nAuckland','Bank 00-0000-0000000-00 — use the invoice number as reference',operator,'ops@example.test');

  -- Off until granted; pause and identity rules hold; oversized fields refused.
  perform pg_temp.prof_reject(save,'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','profile.save','notify');
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.prof_reject(save,'%business actions paused%');
  perform set_action_pause(company,false,'probe','probe resume');
  perform pg_temp.prof_reject(format('select operator_save_business_profile(%L,%L,null,null,null,null,null,null,%L)',company,'X','ops@example.test'),'%operator identity required%');
  perform pg_temp.prof_reject(format('select operator_save_business_profile(%L,%L,null,null,null,null,null,%L,%L)',company,repeat('X',201),operator,'ops@example.test'),'%profile field too long%');

  -- First save lands trimmed, audited once; an exact retry changes nothing and is not
  -- audited twice; an edit needs the loaded timestamp.
  execute save;
  perform pg_temp.prof_assert((select legal_name='Synthetic Fixtures Ltd' and tax_label='GST number' and tax_number='123-456-789'
    from business_profiles where org_id=company),'profile stored');
  perform pg_temp.prof_assert((select count(*)=1 from audit_log where org_id=company and action='profile.save'),'save audited once');
  execute save;
  perform pg_temp.prof_assert((select count(*)=1 from audit_log where org_id=company and action='profile.save'),'exact retry not audited twice');
  perform pg_temp.prof_reject(format('select operator_save_business_profile(%L,%L,%L,%L,null,null,null,%L,%L)',
    company,'Renamed Ltd','GST number','123-456-789',operator,'ops@example.test'),'%changed since it was loaded%');
  t:=(select updated_at from business_profiles where org_id=company);
  perform operator_save_business_profile(company,'Renamed Ltd','GST number','123-456-789',null,'',t,operator,'ops@example.test');
  perform pg_temp.prof_assert((select legal_name='Renamed Ltd' and address is null and payment_instructions is null and updated_at>t
    from business_profiles where org_id=company),'edit lands; empty fields are cleared, never printed');
  perform pg_temp.prof_assert((select count(*)=2 from audit_log where org_id=company and action='profile.save'),'edit audited');

  -- Another business has no profile and gains none from this one.
  perform pg_temp.prof_assert(not exists(select 1 from business_profiles where org_id='63000000-0000-4000-8000-000000000001'),'other business untouched');

  perform pg_temp.prof_assert(not has_function_privilege('anon','operator_save_business_profile(uuid,text,text,text,text,text,timestamptz,uuid,text)','execute')
    and not has_function_privilege('authenticated','operator_save_business_profile(uuid,text,text,text,text,text,timestamptz,uuid,text)','execute')
    and has_function_privilege('service_role','operator_save_business_profile(uuid,text,text,text,text,text,timestamptz,uuid,text)','execute'),
    'the profile entry point is service-only');
  raise notice 'OK: business profile — grant/pause/identity, bounds, first-save and stale-edit rules, retry stability, clearing, isolation and role probes';
end $$;
