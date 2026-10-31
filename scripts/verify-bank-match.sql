-- FLOW-01B-b receipt matching (0052): a credit bank line pays invoices through the
-- payment entry (0043) exactly once per line and invoice, never beyond what remains on
-- the line or what the invoice has outstanding, only in its own currency; lines that are
-- not receipts are marked and reopened with reasons; history is append-only and the
-- entry points are service-only — against a real disposable database.
create function pg_temp.match_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT BANK MATCH: %',msg; end if; end $$;
create function pg_temp.match_reject(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like pattern then raise; end if; return; end;
  raise exception 'ASSERT BANK MATCH expected rejection: %',pattern;
end $$;
do $$
declare
  company uuid:='87000000-0000-4000-8000-000000000001'; other uuid:='87000000-0000-4000-8000-000000000002';
  operator uuid:='87000000-0000-4000-8000-0000000000aa'; email text:='ops@example.test';
  account uuid; acct uuid; inv_a uuid; inv_b uuid; inv_aud uuid; inv_draft uuid; other_line uuid; other_inv uuid;
  l_full uuid; l_over uuid; l_debit uuid; l_owner uuid; r record; v_review uuid; n_ledger int;
  alloc text;
begin
  insert into orgs(id,slug,display_name) values(company,'match-fixture','Synthetic matching drill'),(other,'match-other','Other matching drill');
  perform seed_chart_of_accounts(company);
  insert into accounts(org_id,name) values(company,'Synthetic retailer') returning id into account;
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents,issued_at,due_at) values
    (company,account,'MATCH-1','issued','wholesale','NZD',10000,10000,now()-interval '9 days',now()+interval '5 days') returning id into inv_a;
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents,issued_at,due_at) values
    (company,account,'MATCH-2','issued','wholesale','NZD',5000,5000,now()-interval '9 days',now()+interval '5 days') returning id into inv_b;
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents,issued_at,due_at) values
    (company,account,'MATCH-3','issued','wholesale','AUD',2000,2000,now()-interval '9 days',now()+interval '5 days') returning id into inv_aud;
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents) values
    (company,account,'MATCH-4','draft','wholesale','NZD',100,100) returning id into inv_draft;
  insert into tool_grants(org_id,agent_name,tool_name,risk) values
    (company,'operator','bank_accounts.save','notify'),(company,'operator','bank.import','notify');
  acct:=operator_save_bank_account(company,null,'Everyday','ASB','12-0000-0000001-00','NZD',true,null,operator,email);
  perform operator_import_bank_lines(company,acct,'october.csv',repeat('a',64),
    '[{"row":2,"posted_on":"2026-10-20","amount_cents":"10000","description":"DIRECT CREDIT","reference":"MATCH-1"},
      {"row":3,"posted_on":"2026-10-21","amount_cents":"7000","description":"DIRECT CREDIT","reference":"MATCH-2 and extra"},
      {"row":4,"posted_on":"2026-10-21","amount_cents":"-2500","description":"CARD PURCHASE"},
      {"row":5,"posted_on":"2026-10-22","amount_cents":"3000","description":"TRANSFER FROM SAVINGS"}]'::jsonb,operator,email);
  select id into l_full from bank_transactions where org_id=company and source_row=2;
  select id into l_over from bank_transactions where org_id=company and source_row=3;
  select id into l_debit from bank_transactions where org_id=company and source_row=4;
  select id into l_owner from bank_transactions where org_id=company and source_row=5;
  alloc:='select * from operator_allocate_bank_receipt(%L,%L,%L,%s,%L,%L)';

  -- Recording a payment from a bank line is payment entry: off until payments.record is
  -- granted, and identity is required.
  perform pg_temp.match_reject(format(alloc,company,l_full,inv_a,10000,operator,email),'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','payments.record','notify');
  perform pg_temp.match_reject(format(alloc,company,l_full,inv_a,10000,null,email),'%operator identity required%');
  perform pg_temp.match_reject(format(alloc,company,l_full,inv_a,0,operator,email),'%amount must be positive%');

  -- A full match records the payment once: posted, the invoice paid, the line spent, and
  -- the payment's reference names the bank line.
  n_ledger:=(select count(*) from ledger_transactions where org_id=company and source='payment_received');
  execute format(alloc,company,l_full,inv_a,10000,operator,email) into r;
  perform pg_temp.match_assert(r.oab_invoice_state='paid' and r.oab_remaining_cents=0 and not r.oab_was_existing,'a full match pays the invoice');
  perform pg_temp.match_assert((select reference=format('Bank 2026-10-20 · %s',l_full) and received_at='2026-10-20T00:00:00Z' and posted_at is not null
    from payments where id=r.oab_payment_id),'the payment names the bank line and carries its date');
  perform pg_temp.match_assert((select count(*)=n_ledger+1 from ledger_transactions where org_id=company and source='payment_received'),'posted exactly once');
  perform pg_temp.match_assert((select count(*)=1 from audit_log where org_id=company and action='bank.allocate'),'allocation audited');

  -- The same line and invoice again is a retry; a different amount for the pair, or more
  -- than remains on the line, is refused.
  execute format(alloc,company,l_full,inv_a,10000,operator,email) into r;
  perform pg_temp.match_assert(r.oab_was_existing,'a retry adopts the allocation');
  perform pg_temp.match_assert((select count(*)=n_ledger+1 from ledger_transactions where org_id=company and source='payment_received')
    and (select count(*)=1 from payments where invoice_id=inv_a),'a retry records nothing new');
  perform pg_temp.match_reject(format(alloc,company,l_full,inv_a,9000,operator,email),'%already pays this invoice a different amount%');
  perform pg_temp.match_reject(format(alloc,company,l_full,inv_b,100,operator,email),'%exceeds what remains on this bank line%');

  -- Only credits pay, in the invoice's own currency, within its outstanding, and only
  -- issued invoices take payments.
  perform pg_temp.match_reject(format(alloc,company,l_debit,inv_b,100,operator,email),'%only a credit bank line can pay%');
  perform pg_temp.match_reject(format(alloc,company,l_over,inv_aud,2000,operator,email),'%different currencies%');
  perform pg_temp.match_reject(format(alloc,company,l_over,inv_b,7000,operator,email),'%exceeds what is outstanding%');
  perform pg_temp.match_reject(format(alloc,company,l_over,inv_draft,100,operator,email),'%only an issued invoice%');

  -- An overpaying line settles the invoice and keeps its remainder for another decision.
  execute format(alloc,company,l_over,inv_b,5000,operator,email) into r;
  perform pg_temp.match_assert(r.oab_invoice_state='paid' and r.oab_remaining_cents=2000,'an overpayment settles the invoice and keeps the rest');

  -- Another business's line and invoice are unreachable.
  insert into accounts(org_id,name) values(other,'Other retailer');
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents,issued_at,due_at)
    select other,id,'OTHER-1','issued','wholesale','NZD',100,100,now(),now()+interval '5 days' from accounts where org_id=other returning id into other_inv;
  perform pg_temp.match_reject(format(alloc,company,l_owner,other_inv,100,operator,email),'%invoice not found%');
  insert into bank_accounts(org_id,display_name,bank_name,account_ref,currency,added_by) values(other,'Other','Wise','x-1','NZD','seed');
  insert into bank_import_batches(org_id,bank_account_id,file_name,file_sha256,import_format,line_count,new_count,existing_count,
      first_posted_on,last_posted_on,imported_by,actor_id)
    select other,id,'o.csv',repeat('b',64),'atlas_csv_v1',1,1,0,'2026-10-20','2026-10-20','seed',operator from bank_accounts where org_id=other;
  insert into bank_transactions(org_id,bank_account_id,import_batch_id,line_key,posted_on,amount_cents,currency,description,source_row,raw)
    select other,b.bank_account_id,b.id,'content:x#1','2026-10-20',100,'NZD','OTHER CREDIT',2,'{}'::jsonb from bank_import_batches b where b.org_id=other
    returning id into other_line;
  perform pg_temp.match_reject(format(alloc,company,other_line,inv_b,100,operator,email),'%bank line not found%');

  -- Reviews: off until granted; a credit that is not a receipt is marked with a reason
  -- (an exact retry returns it), cannot then be allocated, and can be reopened.
  perform pg_temp.match_reject(format('select operator_review_bank_line(%L,%L,%L,%L,%L,%L)',company,l_owner,'not_receipt','Owner moving savings',operator,email),'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','bank.review','notify');
  perform pg_temp.match_reject(format('select operator_review_bank_line(%L,%L,%L,%L,%L,%L)',company,l_owner,'not_receipt','no',operator,email),'%reason is required%');
  perform pg_temp.match_reject(format('select operator_review_bank_line(%L,%L,%L,%L,%L,%L)',company,l_owner,'ignore','Owner moving savings',operator,email),'%decision required%');
  v_review:=operator_review_bank_line(company,l_owner,'not_receipt','Owner moving savings',operator,email);
  perform pg_temp.match_assert(operator_review_bank_line(company,l_owner,'not_receipt','Owner moving savings',operator,email)=v_review,'an exact retry returns the decision');
  perform pg_temp.match_reject(format('select operator_review_bank_line(%L,%L,%L,%L,%L,%L)',company,l_owner,'not_receipt','Something else',operator,email),'%already marked as not a receipt%');
  perform pg_temp.match_reject(format(alloc,company,l_owner,inv_b,100,operator,email),'%marked as not a receipt%');
  perform pg_temp.match_reject(format('select operator_review_bank_line(%L,%L,%L,%L,%L,%L)',company,l_full,'not_receipt','Not ours',operator,email),'%already pays an invoice%');
  perform pg_temp.match_reject(format('select operator_review_bank_line(%L,%L,%L,%L,%L,%L)',company,l_debit,'not_receipt','A purchase',operator,email),'%only a credit bank line can be marked%');
  perform operator_review_bank_line(company,l_owner,'reopened','Marked by mistake',operator,email);
  perform pg_temp.match_reject(format('select operator_review_bank_line(%L,%L,%L,%L,%L,%L)',company,l_owner,'reopened','Again',operator,email),'%is not marked as not a receipt%');
  perform pg_temp.match_assert((select count(*)=2 from bank_line_reviews where org_id=company and bank_transaction_id=l_owner)
    and (select count(*)=2 from audit_log where org_id=company and action='bank.review'),'both decisions kept and audited');
  perform pg_temp.match_reject(format('select operator_review_bank_line(%L,%L,%L,%L,%L,%L)',company,other_line,'not_receipt','Not ours',operator,email),'%bank line not found%');

  -- History is append-only.
  perform pg_temp.match_reject(format('update bank_receipt_allocations set amount_cents=1 where bank_transaction_id=%L',l_full),'%append-only evidence%');
  perform pg_temp.match_reject(format('delete from bank_receipt_allocations where bank_transaction_id=%L',l_full),'%append-only evidence%');
  perform pg_temp.match_reject(format('delete from bank_line_reviews where bank_transaction_id=%L',l_owner),'%append-only evidence%');

  perform pg_temp.match_assert(
    has_function_privilege('service_role','operator_allocate_bank_receipt(uuid,uuid,uuid,bigint,uuid,text)','execute')
    and not has_function_privilege('authenticated','operator_allocate_bank_receipt(uuid,uuid,uuid,bigint,uuid,text)','execute')
    and not has_function_privilege('anon','operator_allocate_bank_receipt(uuid,uuid,uuid,bigint,uuid,text)','execute')
    and has_function_privilege('service_role','operator_review_bank_line(uuid,uuid,text,text,uuid,text)','execute')
    and not has_function_privilege('authenticated','operator_review_bank_line(uuid,uuid,text,text,uuid,text)','execute')
    and has_table_privilege('service_role','bank_receipt_allocations','select')
    and not has_table_privilege('service_role','bank_receipt_allocations','insert')
    and not has_table_privilege('authenticated','bank_line_reviews','select'),
    'entry points are service-only; tables are read-only to the service');
  raise notice 'OK: bank receipt matching — payments.record-gated allocation through the payment entry, exactly once per line and invoice, line remainder and invoice outstanding caps, currency and state rules, not-a-receipt reviews with reopen, append-only history and role probes';
end $$;
