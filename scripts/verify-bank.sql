-- FLOW-01B-a bank source (0051): grant/pause/identity enforcement, account identity and
-- stale edits, exactly-once line storage across re-imports and overlapping files,
-- identical lines kept apart, whole-file refusals that write nothing, append-only
-- evidence, cross-business reach and role privileges — against a real disposable database.
create function pg_temp.bank_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT BANK: %',msg; end if; end $$;
create function pg_temp.bank_reject(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like pattern then raise; end if; return; end;
  raise exception 'ASSERT BANK expected rejection: %',pattern;
end $$;
do $$
declare
  company uuid:='86000000-0000-4000-8000-000000000001'; other uuid:='86000000-0000-4000-8000-000000000002';
  operator uuid:='86000000-0000-4000-8000-0000000000aa'; email text:='ops@example.test';
  acct uuid; acct_aud uuid; acct_other uuid; r record; v_updated timestamptz; lines jsonb; save text; imp text;
  n_lines int; n_batches int;
begin
  insert into orgs(id,slug,display_name) values(company,'bank-fixture','Synthetic bank drill'),(other,'bank-other','Other bank drill');
  save:=format('select operator_save_bank_account(%L,null,%L,%L,%L,%L,true,null,%L,%L)',company,'ASB Everyday','ASB','12-3456-0001234-00','NZD',operator,email);

  -- Accounts: off until granted, approve_required refused, pause and identity hold.
  perform pg_temp.bank_reject(save,'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','bank_accounts.save','approve_required');
  perform pg_temp.bank_reject(save,'%must not require approval%');
  update tool_grants set risk='notify' where org_id=company and tool_name='bank_accounts.save';
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.bank_reject(save,'%business actions paused%');
  perform set_action_pause(company,false,'probe','probe resume');
  perform pg_temp.bank_reject(format('select operator_save_bank_account(%L,null,%L,%L,%L,%L,true,null,null,%L)',company,'ASB Everyday','ASB','12-3456','NZD',email),'%operator identity required%');
  perform pg_temp.bank_reject(format('select operator_save_bank_account(%L,null,%L,%L,%L,%L,true,null,%L,%L)',company,'ASB Everyday','ASB','12-3456','NZ',operator,email),'%three-letter code%');
  perform pg_temp.bank_reject(format('select operator_save_bank_account(%L,null,%L,%L,%L,%L,true,null,%L,%L)',company,'ASB Everyday','ASB','x','NZD',operator,email),'%account reference required%');
  perform pg_temp.bank_reject(format('select operator_save_bank_account(%L,null,%L,%L,%L,%L,true,null,%L,%L)',company,'  ','ASB','12-3456','NZD',operator,email),'%account name required%');

  -- Created once; an exact retry (in any letter case) returns it unaudited; the same
  -- identity saying something else is a duplicate; another currency is its own account.
  execute save into acct;
  perform pg_temp.bank_assert((select operator_save_bank_account(company,null,'ASB Everyday','asb','12-3456-0001234-00','nzd',true,null,operator,email))=acct,
    'an exact retry returns the stored account');
  perform pg_temp.bank_assert((select count(*)=1 from audit_log where org_id=company and action='bank_accounts.save'),'account creation audited once');
  perform pg_temp.bank_reject(format('select operator_save_bank_account(%L,null,%L,%L,%L,%L,true,null,%L,%L)',company,'Another name','ASB','12-3456-0001234-00','NZD',operator,email),'%already exists%');
  acct_aud:=operator_save_bank_account(company,null,'ASB Everyday AUD','ASB','12-3456-0001234-00','AUD',true,null,operator,email);
  perform pg_temp.bank_assert(acct_aud<>acct,'a second currency balance is its own account');

  -- Edits change the name and enabled state only; the identity is fixed; a stale page is refused.
  select updated_at into v_updated from bank_accounts where id=acct;
  perform pg_temp.bank_reject(format('select operator_save_bank_account(%L,%L,%L,%L,%L,%L,true,%L,%L,%L)',company,acct,'Renamed','ASB','12-3456-0001234-00','USD',v_updated,operator,email),'%are fixed%');
  perform pg_temp.bank_reject(format('select operator_save_bank_account(%L,%L,%L,%L,%L,%L,true,%L,%L,%L)',company,acct,'Renamed','','','',v_updated-interval '1 second',operator,email),'%changed since it was loaded%');
  perform operator_save_bank_account(company,acct,'ASB Everyday NZD','','','',true,v_updated,operator,email);
  perform pg_temp.bank_assert((select display_name='ASB Everyday NZD' and bank_name='ASB' and currency='NZD' from bank_accounts where id=acct),'rename saved, identity kept');
  insert into bank_accounts(org_id,display_name,bank_name,account_ref,currency,added_by) values(other,'Other business','Wise','other-1','NZD','seed') returning id into acct_other;
  perform pg_temp.bank_reject(format('select operator_save_bank_account(%L,%L,%L,%L,%L,%L,true,now(),%L,%L)',company,acct_other,'Hijack','','','',operator,email),'%bank account not found%');

  -- Imports: off until granted, approve_required refused, pause holds.
  lines:='[{"row":2,"posted_on":"2026-10-01","amount_cents":"14150","description":"DIRECT CREDIT","reference":"ATL-0001","counterparty":"Synthetic Retail North","raw":{"date":"2026-10-01","amount":"141.50"}},
           {"row":3,"posted_on":"2026-10-02","amount_cents":"-1000","description":"CARD 1234 COFFEE"},
           {"row":4,"posted_on":"2026-10-02","amount_cents":"-1000","description":"CARD 1234 COFFEE"},
           {"row":5,"posted_on":"2026-10-03","amount_cents":"999999999999999","description":"LARGEST AMOUNT","currency":"nzd"}]';
  imp:=format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L)',company,acct,'october.csv',repeat('a',64),lines,operator,email);
  perform pg_temp.bank_reject(imp,'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','bank.import','approve_required');
  perform pg_temp.bank_reject(imp,'%must not require approval%');
  update tool_grants set risk='notify' where org_id=company and tool_name='bank.import';
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.bank_reject(imp,'%business actions paused%');
  perform set_action_pause(company,false,'probe','probe resume');

  -- A first import stores every line once, with the batch and one audit row; identical
  -- lines in one file are both kept; amounts are exact and the account currency applies.
  execute imp into r;
  perform pg_temp.bank_assert(r.oib_line_count=4 and r.oib_new_count=4 and r.oib_existing_count=0 and not r.oib_was_existing,'first import stores four new lines');
  perform pg_temp.bank_assert((select count(*)=4 from bank_transactions where org_id=company and bank_account_id=acct),'four lines stored');
  perform pg_temp.bank_assert((select count(*)=2 from bank_transactions where org_id=company and bank_account_id=acct and description='CARD 1234 COFFEE'
    and line_key like 'content:%' and (line_key like '%#1' or line_key like '%#2')),'identical lines are two lines, numbered');
  perform pg_temp.bank_assert((select amount_cents=999999999999999 and currency='NZD' from bank_transactions where org_id=company and description='LARGEST AMOUNT'),'exact amount, account currency');
  perform pg_temp.bank_assert((select reference='ATL-0001' and counterparty='Synthetic Retail North' and source_row=2 and raw->>'amount'='141.50'
    from bank_transactions where org_id=company and description='DIRECT CREDIT'),'source fields and the raw row are kept');
  perform pg_temp.bank_assert((select count(*)=1 from audit_log where org_id=company and action='bank.import'),'import audited once');

  -- The same file again adopts the stored import: nothing new, no second batch or audit.
  execute imp into r;
  perform pg_temp.bank_assert(r.oib_was_existing and r.oib_new_count=4,'an exact re-import adopts the stored batch');
  perform pg_temp.bank_assert((select count(*)=4 from bank_transactions where org_id=company and bank_account_id=acct),'re-import stores nothing');
  perform pg_temp.bank_assert((select count(*)=1 from bank_import_batches where org_id=company and bank_account_id=acct),'one batch');
  perform pg_temp.bank_assert((select count(*)=1 from audit_log where org_id=company and action='bank.import'),'re-import not audited');

  -- An overlapping export stores only what is new; a third identical line is new.
  execute format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L)',company,acct,'overlap.csv',repeat('b',64),
    '[{"row":2,"posted_on":"2026-10-02","amount_cents":"-1000","description":"CARD 1234 COFFEE"},
      {"row":3,"posted_on":"2026-10-02","amount_cents":"-1000","description":"CARD 1234 COFFEE"},
      {"row":4,"posted_on":"2026-10-02","amount_cents":"-1000","description":"CARD 1234 COFFEE"},
      {"row":5,"posted_on":"2026-10-04","amount_cents":"5000","description":"DIRECT CREDIT","reference":"ATL-0002"}]'::jsonb,operator,email) into r;
  perform pg_temp.bank_assert(r.oib_line_count=4 and r.oib_new_count=2 and r.oib_existing_count=2 and not r.oib_was_existing,'overlap: two new, two already held');
  perform pg_temp.bank_assert((select count(*)=6 from bank_transactions where org_id=company and bank_account_id=acct),'six lines after the overlap');
  perform pg_temp.bank_assert((select new_count=2 and existing_count=2 and first_posted_on='2026-10-02' and last_posted_on='2026-10-04'
    from bank_import_batches where org_id=company and file_name='overlap.csv'),'the batch records its counts and range');

  -- Refusals write nothing: bad rows (with their row number), a foreign currency, mixed
  -- identity schemes, a disabled or another business's account, empty or oversized files.
  n_lines:=(select count(*) from bank_transactions where org_id=company); n_batches:=(select count(*) from bank_import_batches where org_id=company);
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L)',company,acct,'bad.csv',repeat('c',64),
    '[{"row":2,"posted_on":"2026-10-05","amount_cents":"100","description":"OK"},{"row":3,"posted_on":"2026-02-30","amount_cents":"100","description":"BAD DATE"}]'::jsonb,operator,email),'%bank row 3 is invalid%');
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L)',company,acct,'bad.csv',repeat('c',64),
    format('[{"row":2,"posted_on":"%s","amount_cents":"100","description":"FUTURE"}]',(current_date+3)::text)::jsonb,operator,email),'%bank row 2 is invalid%');
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L)',company,acct,'bad.csv',repeat('c',64),
    '[{"row":2,"posted_on":"2026-10-05","amount_cents":"12.50","description":"NOT CENTS"}]'::jsonb,operator,email),'%bank row 2 is invalid%');
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L)',company,acct,'bad.csv',repeat('c',64),
    '[{"row":"two","posted_on":"2026-10-05","amount_cents":"1","description":" "}]'::jsonb,operator,email),'%bank row 2 is invalid%');
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L)',company,acct,'bad.csv',repeat('c',64),
    '[{"row":2,"posted_on":"2026-10-05","amount_cents":"100","description":"USD LINE","currency":"USD"}]'::jsonb,operator,email),'%bank row 2 is in a different currency%');
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L)',company,acct,'bad.csv',repeat('c',64),
    '[{"row":2,"posted_on":"2026-10-05","amount_cents":"100","description":"A"},{"row":3,"posted_on":"2026-10-05","amount_cents":"100","description":"B","transaction_id":"T-1"}]'::jsonb,operator,email),'%mixes rows with and without a transaction id%');
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L)',company,acct,'bad.csv',repeat('c',64),
    '[{"row":2,"posted_on":"2026-10-05","amount_cents":"100","description":"B","transaction_id":"T-1"}]'::jsonb,operator,email),'%identifies lines differently%');
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L)',company,acct,'bad.csv',repeat('c',64),'[]'::jsonb,operator,email),'%has no lines%');
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L)',company,acct,'bad.csv',repeat('c',64),
    (select jsonb_agg(jsonb_build_object('row',g+1,'posted_on','2026-10-05','amount_cents','1','description','X')) from generate_series(1,5001) g),operator,email),'%too many lines%');
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L)',company,acct,'bad.csv','not-a-digest',lines,operator,email),'%digest required%');
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L)',company,acct_other,'bad.csv',repeat('c',64),lines,operator,email),'%bank account not found%');
  perform operator_save_bank_account(company,acct_aud,'ASB Everyday AUD','','','',false,(select updated_at from bank_accounts where id=acct_aud),operator,email);
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L)',company,acct_aud,'aud.csv',repeat('d',64),
    '[{"row":2,"posted_on":"2026-10-05","amount_cents":"100","description":"AUD"}]'::jsonb,operator,email),'%bank account is disabled%');
  perform pg_temp.bank_assert((select count(*)=n_lines from bank_transactions where org_id=company)
    and (select count(*)=n_batches from bank_import_batches where org_id=company),'refused files wrote nothing');

  -- An account keyed by the bank's transaction ids: a stored id saying something else,
  -- or an id repeated within one file, refuses the file.
  perform operator_save_bank_account(company,acct_aud,'ASB Everyday AUD','','','',true,(select updated_at from bank_accounts where id=acct_aud),operator,email);
  select * into r from operator_import_bank_lines(company,acct_aud,'aud-1.csv',repeat('e',64),
    '[{"row":2,"posted_on":"2026-10-05","amount_cents":"2500","description":"TRANSFER IN","transaction_id":"TX-1"},
      {"row":3,"posted_on":"2026-10-06","amount_cents":"-300","description":"FEE","transaction_id":"TX-2"}]'::jsonb,operator,email);
  perform pg_temp.bank_assert(r.oib_new_count=2 and (select count(*)=2 from bank_transactions where bank_account_id=acct_aud and line_key in ('id:TX-1','id:TX-2')),'id-keyed lines stored');
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L)',company,acct_aud,'aud-2.csv',repeat('f',64),
    '[{"row":2,"posted_on":"2026-10-05","amount_cents":"2600","description":"TRANSFER IN","transaction_id":"TX-1"}]'::jsonb,operator,email),'%bank row 2 conflicts with a stored line%');
  perform pg_temp.bank_reject(format('select * from operator_import_bank_lines(%L,%L,%L,%L,%L,%L,%L)',company,acct_aud,'aud-2.csv',repeat('f',64),
    '[{"row":2,"posted_on":"2026-10-07","amount_cents":"1","description":"A","transaction_id":"TX-3"},{"row":3,"posted_on":"2026-10-07","amount_cents":"2","description":"B","transaction_id":"TX-3"}]'::jsonb,operator,email),'%bank row 2 repeats a transaction id%');
  select * into r from operator_import_bank_lines(company,acct_aud,'aud-3.csv',repeat('1',64),
    '[{"row":2,"posted_on":"2026-10-05","amount_cents":"2500","description":"TRANSFER IN","transaction_id":"TX-1"},
      {"row":3,"posted_on":"2026-10-08","amount_cents":"700","description":"TRANSFER IN","transaction_id":"TX-4"}]'::jsonb,operator,email);
  perform pg_temp.bank_assert(r.oib_new_count=1 and r.oib_existing_count=1,'a stored id saying the same thing is already held');

  -- Evidence is append-only.
  perform pg_temp.bank_reject(format('update bank_transactions set amount_cents=0 where bank_account_id=%L',acct),'%append-only evidence%');
  perform pg_temp.bank_reject(format('delete from bank_transactions where bank_account_id=%L',acct),'%append-only evidence%');
  perform pg_temp.bank_reject(format('update bank_import_batches set new_count=0 where bank_account_id=%L',acct),'%append-only evidence%');

  -- The entry points are service-only; the helpers and the tables are not reachable directly.
  perform pg_temp.bank_assert(
    not has_function_privilege('anon','operator_import_bank_lines(uuid,uuid,text,text,jsonb,uuid,text)','execute')
    and not has_function_privilege('authenticated','operator_import_bank_lines(uuid,uuid,text,text,jsonb,uuid,text)','execute')
    and has_function_privilege('service_role','operator_import_bank_lines(uuid,uuid,text,text,jsonb,uuid,text)','execute')
    and has_function_privilege('service_role','operator_save_bank_account(uuid,uuid,text,text,text,text,boolean,timestamptz,uuid,text)','execute')
    and not has_function_privilege('authenticated','operator_save_bank_account(uuid,uuid,text,text,text,text,boolean,timestamptz,uuid,text)','execute')
    and not has_function_privilege('service_role','bank_import_keyed(jsonb)','execute')
    and not has_function_privilege('service_role','bank_line_date(text)','execute'),
    'entry points are service-only and helpers are internal');
  perform pg_temp.bank_assert(has_table_privilege('service_role','bank_transactions','select')
    and not has_table_privilege('service_role','bank_transactions','insert')
    and not has_table_privilege('service_role','bank_accounts','update')
    and not has_table_privilege('authenticated','bank_accounts','select'),
    'tables are read-only to the service and closed to browser roles');
  raise notice 'OK: bank source — grants/pause/identity, account identity and stale edits, exactly-once lines across re-imports and overlaps, identical lines kept apart, whole-file refusals, append-only evidence and role probes';
end $$;
