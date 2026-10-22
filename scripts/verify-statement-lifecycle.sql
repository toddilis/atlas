-- CLOSE-01b statement lifecycle (0047): grant/approve_required/pause/identity rules,
-- draft → sent and draft/sent → voided transitions with their evidence columns, the
-- refusals (send on voided, re-void with a different reason), exact-retry stability
-- without double audit, immutability of the snapshot figures across transitions,
-- cross-business reach and role privileges.
create function pg_temp.life_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT STATEMENT LIFECYCLE: %',msg; end if; end $$;
create function pg_temp.life_reject(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like pattern then raise; end if; return; end;
  raise exception 'ASSERT STATEMENT LIFECYCLE expected rejection: %',pattern;
end $$;
do $$
declare
  company uuid:='82000000-0000-4000-8000-000000000001'; rival uuid:='82000000-0000-4000-8000-000000000002';
  operator uuid:='82000000-0000-4000-8000-0000000000aa';
  account uuid; stmt uuid; stmt2 uuid; r record; closing bigint; send text; voidcmd text;
begin
  insert into orgs(id,slug,display_name) values
    (company,'lifecycle-fixture','Synthetic lifecycle drill'),(rival,'lifecycle-rival','Synthetic lifecycle rival');
  insert into accounts(org_id,name) values(company,'Synthetic lifecycle payer') returning id into account;
  perform seed_chart_of_accounts(company);
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents,issued_at,due_at)
    values(company,account,'LIFE-1','issued','wholesale','NZD',30000,30000,now()-interval '20 days',now()-interval '6 days');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','statements.generate','notify');
  select ogs_statement_id into stmt from operator_generate_statement(company,account,now()-interval '30 days',now(),
    'Pacific/Auckland',operator,'ops@example.test');
  select closing_balance_cents into closing from statements where id=stmt;
  send:=format('select * from operator_record_statement_sent(%L,%L,%L,%L)',company,stmt,operator,'ops@example.test');
  voidcmd:=format('select * from operator_void_statement(%L,%L,%L,%L,%L)',company,stmt,'superseded by a redraft',operator,'ops@example.test');

  -- Off until granted; approve_required refused outright; pause and identity hold.
  perform pg_temp.life_reject(send,'%tool entitlement missing or revoked%');
  perform pg_temp.life_reject(voidcmd,'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values
    (company,'operator','statements.record_send','approve_required'),(company,'operator','statements.void','approve_required');
  perform pg_temp.life_reject(send,'%must not require approval%');
  perform pg_temp.life_reject(voidcmd,'%must not require approval%');
  update tool_grants set risk='notify' where org_id=company and tool_name in ('statements.record_send','statements.void');
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.life_reject(send,'%business actions paused%');
  perform pg_temp.life_reject(voidcmd,'%business actions paused%');
  perform set_action_pause(company,false,'probe','probe resume');
  perform pg_temp.life_reject(format('select * from operator_record_statement_sent(%L,%L,null,%L)',company,stmt,'ops@example.test'),
    '%operator identity required%');
  perform pg_temp.life_reject(format('select * from operator_void_statement(%L,%L,%L,%L,%L)',company,stmt,'  ',operator,'ops@example.test'),
    '%void reason required%');
  perform pg_temp.life_reject(format('select * from operator_void_statement(%L,%L,%L,%L,%L)',company,stmt,repeat('x',501),operator,'ops@example.test'),
    '%void reason too long%');

  -- The rival business, fully granted, still cannot reach the statement: isolation is
  -- the subject lookup, not a missing grant.
  insert into tool_grants(org_id,agent_name,tool_name,risk) values
    (rival,'operator','statements.record_send','notify'),(rival,'operator','statements.void','notify');
  perform pg_temp.life_reject(format('select * from operator_record_statement_sent(%L,%L,%L,%L)',rival,stmt,operator,'ops@example.test'),
    '%statement not found%');
  perform pg_temp.life_reject(format('select * from operator_void_statement(%L,%L,%L,%L,%L)',rival,stmt,'cross-business probe',operator,'ops@example.test'),
    '%statement not found%');

  -- draft → sent stamps the evidence and audits once; the exact retry returns the
  -- recorded fact with no second audit and no new timestamp.
  select * into r from operator_record_statement_sent(company,stmt,operator,'ops@example.test');
  perform pg_temp.life_assert(r.orss_state='sent' and r.orss_sent_at is not null,'send transitions draft to sent');
  perform pg_temp.life_assert((select state='sent' and sent_by='ops@example.test' and sent_at is not null from statements where id=stmt),
    'sent evidence stamped on the row');
  perform pg_temp.life_assert((select count(*)=1 from audit_log where org_id=company and action='statements.record_send'),'send audited once');
  select * into r from operator_record_statement_sent(company,stmt,operator,'ops@example.test');
  perform pg_temp.life_assert(r.orss_state='sent' and r.orss_sent_at=(select sent_at from statements where id=stmt),'send retry returns the recorded fact');
  perform pg_temp.life_assert((select count(*)=1 from audit_log where org_id=company and action='statements.record_send'),'send retry not audited twice');

  -- sent → voided with a reason; the snapshot figures do not move; the exact retry
  -- (same reason) is stable and a different reason is refused, as is sending a voided
  -- statement.
  select * into r from operator_void_statement(company,stmt,'superseded by a redraft',operator,'ops@example.test');
  perform pg_temp.life_assert(r.ovs_state='voided' and r.ovs_voided_at is not null,'void transitions sent to voided');
  perform pg_temp.life_assert((select state='voided' and voided_by='ops@example.test' and voided_reason='superseded by a redraft'
    and sent_at is not null and closing_balance_cents=closing from statements where id=stmt),
    'void evidence stamped; send history and figures untouched');
  perform pg_temp.life_assert((select count(*)=1 from audit_log where org_id=company and action='statements.void'),'void audited once');
  select * into r from operator_void_statement(company,stmt,'superseded by a redraft',operator,'ops@example.test');
  perform pg_temp.life_assert(r.ovs_state='voided' and r.ovs_voided_at=(select voided_at from statements where id=stmt),'void retry returns the recorded fact');
  perform pg_temp.life_assert((select count(*)=1 from audit_log where org_id=company and action='statements.void'),'void retry not audited twice');
  perform pg_temp.life_reject(format('select * from operator_void_statement(%L,%L,%L,%L,%L)',company,stmt,'a different story',operator,'ops@example.test'),
    '%statement already voided%');
  perform pg_temp.life_reject(send,'%statement already voided%');

  -- A draft can be voided directly (wrong statement generated), without ever being sent.
  select ogs_statement_id into stmt2 from operator_generate_statement(company,account,now()-interval '30 days',clock_timestamp(),
    'Pacific/Auckland',operator,'ops@example.test');
  select * into r from operator_void_statement(company,stmt2,'generated for the wrong period',operator,'ops@example.test');
  perform pg_temp.life_assert(r.ovs_state='voided' and (select sent_at is null and voided_reason='generated for the wrong period'
    from statements where id=stmt2),'a draft voids directly with its reason');
  perform pg_temp.life_assert((select detail->>'was_state'='draft' from audit_log where org_id=company and action='statements.void'
    and subject_id=stmt2),'the audit names the prior state');

  perform pg_temp.life_assert(not has_function_privilege('anon','operator_record_statement_sent(uuid,uuid,uuid,text)','execute')
    and not has_function_privilege('authenticated','operator_record_statement_sent(uuid,uuid,uuid,text)','execute')
    and has_function_privilege('service_role','operator_record_statement_sent(uuid,uuid,uuid,text)','execute')
    and not has_function_privilege('anon','operator_void_statement(uuid,uuid,text,uuid,text)','execute')
    and not has_function_privilege('authenticated','operator_void_statement(uuid,uuid,text,uuid,text)','execute')
    and has_function_privilege('service_role','operator_void_statement(uuid,uuid,text,uuid,text)','execute'),
    'the lifecycle entry points are service-only');
  raise notice 'OK: statement lifecycle — grant/approve_required/pause/identity, sent and voided evidence, refusals, retry stability, immutable figures, isolation and role probes';
end $$;
