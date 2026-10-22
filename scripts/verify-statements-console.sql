-- STMT-01 console statement generation (0044): grant/pause/identity enforcement,
-- as-of and timezone validity, the derivation reflecting a recorded payment,
-- exact-retry stability without a duplicate row or second audit, deliberate redrafts
-- as new rows, cross-business reach and role privileges.
create function pg_temp.stmt_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT STATEMENTS: %',msg; end if; end $$;
create function pg_temp.stmt_reject(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like pattern then raise; end if; return; end;
  raise exception 'ASSERT STATEMENTS expected rejection: %',pattern;
end $$;
do $$
declare
  company uuid:='80000000-0000-4000-8000-000000000001'; operator uuid:='80000000-0000-4000-8000-0000000000aa';
  account uuid; invoice uuid; period timestamptz:=now()-interval '30 days'; r record; again record; redraft record;
  generate text;
begin
  insert into orgs(id,slug,display_name) values(company,'statement-fixture','Synthetic statement drill');
  insert into accounts(org_id,name) values(company,'Synthetic statement payer') returning id into account;
  perform seed_chart_of_accounts(company);
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents,issued_at,due_at)
    values(company,account,'STMT-1','issued','wholesale','NZD',20000,20000,now()-interval '20 days',now()-interval '6 days') returning id into invoice;
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','payments.record','notify');
  perform operator_record_payment(company,invoice,5000,now()-interval '2 days','STMT-BANK-1',operator,'ops@example.test');
  generate:=format('select * from operator_generate_statement(%L,%L,%L,clock_timestamp(),%L,%L,%L)',
    company,account,period,'Pacific/Auckland',operator,'ops@example.test');

  -- Off until granted; pause, identity, as-of and timezone rules hold.
  perform pg_temp.stmt_reject(generate,'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','statements.generate','notify');
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.stmt_reject(generate,'%business actions paused%');
  perform set_action_pause(company,false,'probe','probe resume');
  perform pg_temp.stmt_reject(format('select * from operator_generate_statement(%L,%L,%L,clock_timestamp(),%L,null,%L)',
    company,account,period,'Pacific/Auckland','ops@example.test'),'%operator identity required%');
  perform pg_temp.stmt_reject(format('select * from operator_generate_statement(%L,%L,%L,%L,%L,%L,%L)',
    company,account,period,now()+interval '2 days','Pacific/Auckland',operator,'ops@example.test'),'%must not be in the future%');
  perform pg_temp.stmt_reject(format('select * from operator_generate_statement(%L,%L,%L,clock_timestamp(),%L,%L,%L)',
    company,account,period,'Atlantis/Nowhere',operator,'ops@example.test'),'%unknown statement timezone%');
  perform pg_temp.stmt_reject(format('select * from operator_generate_statement(%L,%L,%L,clock_timestamp(),%L,%L,%L)',
    company,'63000000-0000-4000-8000-000000000002',period,'Pacific/Auckland',operator,'ops@example.test'),'%not found%');

  -- The statement reflects the recorded payment: 200.00 issued, 50.00 paid → 150.00
  -- closing, lines footed by the 0020 derivation, audited once.
  select * into r from operator_generate_statement(company,account,period,now(),'Pacific/Auckland',operator,'ops@example.test');
  perform pg_temp.stmt_assert(r.ogs_closing_balance_cents=15000,'closing is issued minus paid');
  perform pg_temp.stmt_assert(r.ogs_line_count>=2,'statement carries the invoice and payment lines');
  perform pg_temp.stmt_assert((select currency='NZD' and generated_by_agent='ops@example.test' from statements where id=r.ogs_statement_id),'statement named its operator');
  perform pg_temp.stmt_assert((select count(*)=1 from audit_log where org_id=company and action='statements.generate'),'generation audited once');

  -- An exact retry returns the same statement with no duplicate row and no second
  -- audit; a redraft at a new as-of is a new row by design (0015).
  select * into again from operator_generate_statement(company,account,period,
    (select as_of_at from statements where id=r.ogs_statement_id),'Pacific/Auckland',operator,'ops@example.test');
  perform pg_temp.stmt_assert(again.ogs_statement_id=r.ogs_statement_id and again.ogs_closing_balance_cents=15000,'retry returns the generated statement');
  perform pg_temp.stmt_assert((select count(*)=1 from statements where org_id=company),'retry adds no duplicate row');
  perform pg_temp.stmt_assert((select count(*)=1 from audit_log where org_id=company and action='statements.generate'),'retry not audited twice');
  select * into redraft from operator_generate_statement(company,account,period,clock_timestamp(),'Pacific/Auckland',operator,'ops@example.test');
  perform pg_temp.stmt_assert(redraft.ogs_statement_id<>r.ogs_statement_id,'a new as-of is a deliberate redraft');
  perform pg_temp.stmt_assert((select count(*)=2 from statements where org_id=company),'the redraft is its own row');

  perform pg_temp.stmt_assert(not has_function_privilege('anon','operator_generate_statement(uuid,uuid,timestamptz,timestamptz,text,uuid,text)','execute')
    and not has_function_privilege('authenticated','operator_generate_statement(uuid,uuid,timestamptz,timestamptz,text,uuid,text)','execute')
    and has_function_privilege('service_role','operator_generate_statement(uuid,uuid,timestamptz,timestamptz,text,uuid,text)','execute'),
    'the statement entry point is service-only');
  raise notice 'OK: console statement generation — grant/pause/identity, as-of and timezone rules, payment-aware closing, retry stability, redrafts, audit and role probes';
end $$;
