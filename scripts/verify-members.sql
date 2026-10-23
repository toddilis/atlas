-- TENANT-01b membership (0049): grant/approve_required/pause/identity rules, email
-- validity and normalization, the lockout guards (first member is yourself; nobody
-- disables themselves), create retry stability without double audit, stale-edit rules,
-- fixed email, cross-business isolation with the rival fully granted, and role
-- privileges. The console-boundary enforcement itself is proven in the browser journey.
create function pg_temp.mem_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT MEMBERS: %',msg; end if; end $$;
create function pg_temp.mem_reject(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like pattern then raise; end if; return; end;
  raise exception 'ASSERT MEMBERS expected rejection: %',pattern;
end $$;
do $$
declare
  company uuid:='84000000-0000-4000-8000-000000000001'; rival uuid:='84000000-0000-4000-8000-000000000002';
  operator uuid:='84000000-0000-4000-8000-0000000000aa';
  r record; again record; other record; addself text;
begin
  insert into orgs(id,slug,display_name) values
    (company,'members-fixture','Synthetic members drill'),(rival,'members-rival','Synthetic members rival');
  addself:=format('select * from operator_save_member(%L,null,%L,true,null,%L,%L)',company,'Boss@Example.Test ',operator,'boss@example.test');

  -- Off until granted (never seeded); approve_required refused; pause and identity hold.
  perform pg_temp.mem_reject(addself,'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','members.save','approve_required');
  perform pg_temp.mem_reject(addself,'%must not require approval%');
  update tool_grants set risk='notify' where org_id=company and tool_name='members.save';
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.mem_reject(addself,'%business actions paused%');
  perform set_action_pause(company,false,'probe','probe resume');
  perform pg_temp.mem_reject(format('select * from operator_save_member(%L,null,%L,true,null,null,%L)',company,'boss@example.test','boss@example.test'),
    '%operator identity required%');
  perform pg_temp.mem_reject(format('select * from operator_save_member(%L,null,%L,true,null,%L,%L)',company,'not-an-email',operator,'boss@example.test'),
    '%valid member email is required%');
  perform pg_temp.mem_reject(format('select * from operator_save_member(%L,null,%L,true,null,%L,%L)',company,repeat('x',310)||'@example.test',operator,'boss@example.test'),
    '%valid member email is required%');

  -- The first member must be the acting operator; then they land, normalized to lower.
  perform pg_temp.mem_reject(format('select * from operator_save_member(%L,null,%L,true,null,%L,%L)',company,'other@example.test',operator,'boss@example.test'),
    '%add your own membership first%');
  execute addself into r;
  perform pg_temp.mem_assert((select email='boss@example.test' and enabled and added_by='boss@example.test'
    from org_members where id=r.osm_member_id),'first member stored normalized and attributed');
  perform pg_temp.mem_assert((select count(*)=1 from audit_log where org_id=company and action='members.save'),'add audited once');

  -- An exact create retry returns the member unchanged without a second audit; the same
  -- email with a different flag is a conflict, not a silent update.
  execute addself into again;
  perform pg_temp.mem_assert(again.osm_member_id=r.osm_member_id and again.osm_updated_at=r.osm_updated_at,'create retry returns the member');
  perform pg_temp.mem_assert((select count(*)=1 from audit_log where org_id=company and action='members.save'),'retry not audited twice');
  perform pg_temp.mem_reject(format('select * from operator_save_member(%L,null,%L,false,null,%L,%L)',company,'boss@example.test',operator,'boss@example.test'),
    '%member already exists%');

  -- A second member; edits need the loaded token; the email is fixed; nobody disables
  -- themselves; disabling the other works and moves the token.
  select * into other from operator_save_member(company,null,'other@example.test',true,null,operator,'boss@example.test');
  perform pg_temp.mem_reject(format('select * from operator_save_member(%L,%L,%L,false,null,%L,%L)',company,other.osm_member_id,'other@example.test',operator,'boss@example.test'),
    '%member changed since it was loaded%');
  perform pg_temp.mem_reject(format('select * from operator_save_member(%L,%L,%L,false,%L,%L,%L)',company,other.osm_member_id,'renamed@example.test',other.osm_updated_at,operator,'boss@example.test'),
    '%member email is fixed%');
  perform pg_temp.mem_reject(format('select * from operator_save_member(%L,%L,%L,false,%L,%L,%L)',company,r.osm_member_id,'boss@example.test',r.osm_updated_at,operator,'boss@example.test'),
    '%you cannot disable your own membership%');
  select * into again from operator_save_member(company,other.osm_member_id,'other@example.test',false,other.osm_updated_at,operator,'boss@example.test');
  perform pg_temp.mem_assert((select not enabled from org_members where id=other.osm_member_id),'the other member is disabled');
  perform pg_temp.mem_assert(again.osm_updated_at>other.osm_updated_at,'the stale token moved');
  perform pg_temp.mem_reject(format('select * from operator_save_member(%L,%L,%L,true,%L,%L,%L)',company,other.osm_member_id,'other@example.test',other.osm_updated_at,operator,'boss@example.test'),
    '%member changed since it was loaded%');

  -- The rival business, fully granted, cannot reach this business's member, and runs its
  -- own first-member rule independently.
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(rival,'operator','members.save','notify');
  perform pg_temp.mem_reject(format('select * from operator_save_member(%L,%L,%L,false,%L,%L,%L)',rival,r.osm_member_id,'boss@example.test',r.osm_updated_at,operator,'boss@example.test'),
    '%member not found%');
  perform pg_temp.mem_reject(format('select * from operator_save_member(%L,null,%L,true,null,%L,%L)',rival,'boss@example.test',operator,'rival@example.test'),
    '%add your own membership first%');
  perform pg_temp.mem_assert((select count(*)=0 from org_members where org_id=rival),'no rival member landed');

  -- Direct rows obey the normalization constraint; the roles hold only what they need.
  perform pg_temp.mem_reject(format('insert into org_members(org_id,email,added_by) values(%L,%L,%L)',company,'Mixed@Case.Test','probe'),
    '%violates check constraint%');
  perform pg_temp.mem_assert(not has_function_privilege('anon','operator_save_member(uuid,uuid,text,boolean,timestamptz,uuid,text)','execute')
    and not has_function_privilege('authenticated','operator_save_member(uuid,uuid,text,boolean,timestamptz,uuid,text)','execute')
    and has_function_privilege('service_role','operator_save_member(uuid,uuid,text,boolean,timestamptz,uuid,text)','execute')
    and has_table_privilege('service_role','org_members','select')
    and not has_table_privilege('anon','org_members','select')
    and not has_table_privilege('authenticated','org_members','select'),
    'members surface is service-only');
  raise notice 'OK: membership — grant/approve_required/pause/identity, email rules, lockout guards, retry stability, stale edits, fixed email, isolation and role probes';
end $$;
