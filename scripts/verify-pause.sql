-- UI-01b console pause/resume (0041): grant and identity enforcement, the durable
-- pause taking effect on other operator entry points, resume working WHILE PAUSED,
-- audit, and role privileges — against a real disposable database.
create function pg_temp.pause_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT PAUSE: %',msg; end if; end $$;
create function pg_temp.pause_reject(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like pattern then raise; end if; return; end;
  raise exception 'ASSERT PAUSE expected rejection: %',pattern;
end $$;
do $$
declare
  company uuid:='77000000-0000-4000-8000-000000000001'; operator uuid:='77000000-0000-4000-8000-0000000000aa';
  pause text; resume text;
begin
  insert into orgs(id,slug,display_name) values(company,'pause-fixture','Synthetic pause drill');
  pause:=format('select operator_set_action_pause(%L,true,%L,%L,%L)',company,operator,'ops@example.test','Synthetic drill');
  resume:=format('select operator_set_action_pause(%L,false,%L,%L,%L)',company,operator,'ops@example.test','Drill over');

  -- Off until granted; identity and a reason are always required.
  perform pg_temp.pause_reject(pause,'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values
    (company,'operator','actions.pause','notify'),(company,'operator','catalog.save','notify');
  perform pg_temp.pause_reject(format('select operator_set_action_pause(%L,true,null,%L,%L)',company,'ops@example.test','Synthetic drill'),'%operator identity required%');
  perform pg_temp.pause_reject(format('select operator_set_action_pause(%L,true,%L,%L,%L)',company,operator,'ops@example.test','x'),'%pause reason required%');

  -- Pause lands durably with who and why, audited once for the operator.
  execute pause;
  perform pg_temp.pause_assert((select paused and changed_by='ops@example.test' and reason='Synthetic drill'
    from action_controls where org_id=company),'pause stored durably with who and why');
  perform pg_temp.pause_assert((select count(*)=1 from audit_log where org_id=company and agent_name='operator' and action='actions.pause'),'pause audited for the operator');

  -- The pause takes effect on other operator entry points, and the pause control
  -- itself still works: resuming while paused is the whole point.
  perform pg_temp.pause_reject(format('select operator_save_product(%L,null,%L,%L,%L,true,null,%L,%L)',company,'DRILL','Paused product','each',operator,'ops@example.test'),'%business actions paused%');
  execute resume;
  perform pg_temp.pause_assert((select not paused and reason='Drill over' from action_controls where org_id=company),'resume lands while paused');
  perform pg_temp.pause_assert((select count(*)=1 from audit_log where org_id=company and agent_name='operator' and action='actions.resume'),'resume audited for the operator');
  perform operator_save_product(company,null,'DRILL','Paused product','each',true,null,operator,'ops@example.test');

  -- A grant that waits for approval is refused outright, and a revoked grant blocks
  -- both directions.
  update tool_grants set risk='approve_required' where org_id=company and tool_name='actions.pause';
  perform pg_temp.pause_reject(pause,'%must not require approval%');
  update tool_grants set risk='notify',enabled=false where org_id=company and tool_name='actions.pause';
  perform pg_temp.pause_reject(pause,'%tool entitlement missing or revoked%');
  perform pg_temp.pause_reject(resume,'%tool entitlement missing or revoked%');

  perform pg_temp.pause_assert(not has_function_privilege('anon','operator_set_action_pause(uuid,boolean,uuid,text,text)','execute')
    and not has_function_privilege('authenticated','operator_set_action_pause(uuid,boolean,uuid,text,text)','execute')
    and has_function_privilege('service_role','operator_set_action_pause(uuid,boolean,uuid,text,text)','execute'),
    'the pause entry point is service-only');
  raise notice 'OK: console pause/resume — grant/identity/reason rules, durable pause blocking other entry points, resume while paused, audit and role probes';
end $$;
