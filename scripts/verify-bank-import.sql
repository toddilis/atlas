-- FLOW-01B bank source (0051): grant rules (import never-seeded, approve_required
-- refused; review seeded class; matching under payments.record), pause and identity,
-- per-line validation by line number, file retry stability, per-line dedupe across
-- overlapping files, source immutability, the match path recording a payment exactly
-- once with a line-unique reference, debit/currency/overpay refusals, set-aside and
-- reopen with their guards, cross-business isolation with the rival fully granted, and
-- role privileges.
create function pg_temp.bank_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT BANK: %',msg; end if; end $$;
create function pg_temp.bank_reject(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like pattern then raise; end if; return; end;
  raise exception 'ASSERT BANK expected rejection: %',pattern;
end $$;
create function pg_temp.bank_lines_json(a bigint,b bigint,c bigint) returns jsonb language sql as $$
  select jsonb_build_array(
    jsonb_build_object('occurred_on','2026-10-02','amount_cents',a::text,'currency','NZD','description','Transfer one','reference','INV-REF-1','counterparty','Payer A'),
    jsonb_build_object('occurred_on','2026-10-03','amount_cents',b::text,'currency','NZD','description','Transfer two','reference','','counterparty',''),
    jsonb_build_object('occurred_on','2026-10-04','amount_cents',c::text,'currency','NZD','description','Bank fee','reference','','counterparty','Bank'))
$$;
do $$
declare
  company uuid:='86000000-0000-4000-8000-000000000001'; rival uuid:='86000000-0000-4000-8000-000000000002';
  operator uuid:='86000000-0000-4000-8000-0000000000aa';
  account uuid; invoice uuid; r record; m record; again record; line_credit uuid; line_small uuid; line_fee uuid;
  importcmd text; sha1 text:=repeat('a',64); sha2 text:=repeat('b',64); sha3 text:=repeat('c',64);
begin
  insert into orgs(id,slug,display_name) values
    (company,'bank-fixture','Synthetic bank drill'),(rival,'bank-rival','Synthetic bank rival');
  insert into accounts(org_id,name) values(company,'Synthetic bank payer') returning id into account;
  perform seed_chart_of_accounts(company);
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents,issued_at,due_at)
    values(company,account,'BANK-1','issued','wholesale','NZD',20000,20000,now()-interval '20 days',now()+interval '10 days') returning id into invoice;
  importcmd:=format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,pg_temp.bank_lines_json(20000,555,-1234),%L,%L)',
    company,'Wise NZD','NZD','october.csv',sha1,operator,'ops@example.test');

  -- Off until granted (never seeded); approve_required refused; pause and identity hold.
  perform pg_temp.bank_reject(importcmd,'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','bank.import','approve_required');
  perform pg_temp.bank_reject(importcmd,'%must not require approval%');
  update tool_grants set risk='notify' where org_id=company and tool_name='bank.import';
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.bank_reject(importcmd,'%business actions paused%');
  perform set_action_pause(company,false,'probe','probe resume');
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,pg_temp.bank_lines_json(20000,555,-1234),null,%L)',
    company,'Wise NZD','NZD','october.csv',sha1,'ops@example.test'),'%operator identity required%');

  -- Per-line validation names the line; a currency mismatch is refused whole.
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L,%L)',
    company,'Wise NZD','NZD','bad.csv',sha3,
    '[{"occurred_on":"not-a-date","amount_cents":"100","currency":"NZD","description":"x"}]'::text,
    operator,'ops@example.test'),'%bank line 1: a valid date is required%');
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L,%L)',
    company,'Wise NZD','NZD','bad.csv',sha3,
    '[{"occurred_on":"2026-10-02","amount_cents":"100","currency":"USD","description":"x"}]'::text,
    operator,'ops@example.test'),'%bank line 1: currency does not match the account%');
  perform pg_temp.bank_assert((select count(*)=0 from bank_lines where org_id=company),'a refused file imports nothing');

  -- The import lands whole; the exact file retry returns the batch and adds nothing.
  execute importcmd into r;
  perform pg_temp.bank_assert(r.oib_inserted=3 and r.oib_duplicates=0,'three lines imported');
  perform pg_temp.bank_assert((select count(*)=1 from audit_log where org_id=company and action='bank.import'),'import audited once');
  execute importcmd into again;
  perform pg_temp.bank_assert(again.oib_import_id=r.oib_import_id and again.oib_inserted=0,'file retry returns the batch');
  perform pg_temp.bank_assert((select count(*)=3 from bank_lines where org_id=company),'retry adds no lines');
  perform pg_temp.bank_assert((select count(*)=1 from audit_log where org_id=company and action='bank.import'),'retry not audited twice');
  -- An overlapping export (same lines, one new) dedupes per line.
  select * into again from operator_import_bank_lines(company,'Wise NZD','NZD','overlap.csv',sha2,
    pg_temp.bank_lines_json(20000,555,-1234)||jsonb_build_array(jsonb_build_object(
      'occurred_on','2026-10-05','amount_cents','777','currency','NZD','description','New line','reference','','counterparty','')),
    operator,'ops@example.test');
  perform pg_temp.bank_assert(again.oib_inserted=1 and again.oib_duplicates=3,'overlap imports only the new line');
  -- The same account name with a different currency is refused.
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,pg_temp.bank_lines_json(1,2,-3),%L,%L)',
    company,'Wise NZD','USD','usd.csv',sha3,operator,'ops@example.test'),'%different currency%');

  select id into line_credit from bank_lines where org_id=company and amount_cents=20000;
  select id into line_small from bank_lines where org_id=company and amount_cents=555;
  select id into line_fee from bank_lines where org_id=company and amount_cents=-1234;

  -- Source content is immutable; resolution columns are the only mutable ones.
  perform pg_temp.bank_reject(format('update bank_lines set amount_cents=1 where id=%L',line_credit),'%bank line source content is immutable%');
  perform pg_temp.bank_reject(format('delete from bank_lines where id=%L',line_credit),'%append-only%');

  -- Matching: payments.record is the authority; a debit never matches; the payment lands
  -- exactly once with a line-unique reference and the line is stamped in the same
  -- transaction. The retry returns the recorded fact.
  perform pg_temp.bank_reject(format('select * from operator_match_bank_line(%L,%L,%L,%L,%L)',company,line_credit,invoice,operator,'ops@example.test'),
    '%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','payments.record','notify');
  perform pg_temp.bank_reject(format('select * from operator_match_bank_line(%L,%L,%L,%L,%L)',company,line_fee,invoice,operator,'ops@example.test'),
    '%only a credit bank line%');
  select * into m from operator_match_bank_line(company,line_credit,invoice,operator,'ops@example.test');
  perform pg_temp.bank_assert(m.omb_invoice_state='paid','the exact credit pays the invoice in full');
  perform pg_temp.bank_assert((select state='matched' and matched_payment_id=m.omb_payment_id from bank_lines where id=line_credit),'line stamped matched');
  perform pg_temp.bank_assert((select count(*)=1 from payments where org_id=company and invoice_id=invoice),'exactly one payment');
  select * into again from operator_match_bank_line(company,line_credit,invoice,operator,'ops@example.test');
  perform pg_temp.bank_assert(again.omb_payment_id=m.omb_payment_id,'match retry returns the recorded payment');
  perform pg_temp.bank_assert((select count(*)=1 from payments where org_id=company and invoice_id=invoice),'retry posts no second payment');
  perform pg_temp.bank_reject(format('select * from operator_match_bank_line(%L,%L,%L,%L,%L)',
    company,line_credit,'86000000-0000-4000-8000-00000000beef',operator,'ops@example.test'),'%bank line already matched%');
  -- The paid invoice refuses the next credit through the payment path's own guard.
  perform pg_temp.bank_reject(format('select * from operator_match_bank_line(%L,%L,%L,%L,%L)',company,line_small,invoice,operator,'ops@example.test'),
    '%already fully paid%');
  perform pg_temp.bank_assert((select state='unmatched' from bank_lines where id=line_small),'a refused match leaves the line unmatched');

  -- Set aside needs the seeded review grant and a reason; a matched line never moves.
  perform pg_temp.bank_reject(format('select operator_set_aside_bank_line(%L,%L,%L,%L,%L)',company,line_fee,'bank fee for the books',operator,'ops@example.test'),
    '%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','bank.review','notify');
  perform pg_temp.bank_reject(format('select operator_set_aside_bank_line(%L,%L,%L,%L,%L)',company,line_fee,'x',operator,'ops@example.test'),
    '%reason is required%');
  perform operator_set_aside_bank_line(company,line_fee,'bank fee for the books',operator,'ops@example.test');
  perform pg_temp.bank_assert((select state='set_aside' and set_aside_reason='bank fee for the books' from bank_lines where id=line_fee),'fee set aside with reason');
  perform operator_set_aside_bank_line(company,line_fee,'bank fee for the books',operator,'ops@example.test'); -- exact retry, no error
  perform pg_temp.bank_reject(format('select operator_set_aside_bank_line(%L,%L,%L,%L,%L)',company,line_fee,'a different story',operator,'ops@example.test'),
    '%already set aside%');
  perform pg_temp.bank_reject(format('select * from operator_match_bank_line(%L,%L,%L,%L,%L)',company,line_fee,invoice,operator,'ops@example.test'),
    '%set aside; reopen it first%');
  perform pg_temp.bank_reject(format('select operator_set_aside_bank_line(%L,%L,%L,%L,%L)',company,line_credit,'should never move',operator,'ops@example.test'),
    '%matched bank line cannot be set aside%');
  perform operator_reopen_bank_line(company,line_fee,operator,'ops@example.test');
  perform pg_temp.bank_assert((select state='unmatched' and set_aside_reason is null from bank_lines where id=line_fee),'reopen returns the line');
  perform pg_temp.bank_reject(format('select operator_reopen_bank_line(%L,%L,%L,%L)',company,line_credit,operator,'ops@example.test'),
    '%cannot be reopened; its payment exists%');

  -- The rival business, fully granted, cannot reach these lines.
  insert into tool_grants(org_id,agent_name,tool_name,risk) values
    (rival,'operator','bank.import','notify'),(rival,'operator','bank.review','notify'),(rival,'operator','payments.record','notify');
  perform pg_temp.bank_reject(format('select * from operator_match_bank_line(%L,%L,%L,%L,%L)',rival,line_small,invoice,operator,'ops@example.test'),
    '%bank line not found%');
  perform pg_temp.bank_reject(format('select operator_set_aside_bank_line(%L,%L,%L,%L,%L)',rival,line_small,'cross-business probe',operator,'ops@example.test'),
    '%bank line not found%');

  perform pg_temp.bank_assert(not has_function_privilege('anon','operator_import_bank_lines(uuid,text,text,text,text,jsonb,uuid,text)','execute')
    and not has_function_privilege('authenticated','operator_import_bank_lines(uuid,text,text,text,text,jsonb,uuid,text)','execute')
    and has_function_privilege('service_role','operator_import_bank_lines(uuid,text,text,text,text,jsonb,uuid,text)','execute')
    and has_function_privilege('service_role','operator_match_bank_line(uuid,uuid,uuid,uuid,text)','execute')
    and not has_table_privilege('anon','bank_lines','select')
    and has_table_privilege('service_role','bank_lines','select'),
    'the bank surface is service-only');
  raise notice 'OK: bank source — grant/approve_required/pause/identity, per-line validation, file retry and per-line dedupe, immutability, exactly-once matching with refusals, set-aside/reopen guards, isolation and role probes';
end $$;
