-- PAY-01 console bank payment (0043): grant/pause/identity enforcement, state and
-- validity refusals, the outstanding cap, exactly-once posting through
-- post_payment_received (0018), reference-keyed retry stability, audit, cross-business
-- reach and role privileges — against a real disposable database.
create function pg_temp.pay_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT PAYMENTS: %',msg; end if; end $$;
create function pg_temp.pay_reject(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like pattern then raise; end if; return; end;
  raise exception 'ASSERT PAYMENTS expected rejection: %',pattern;
end $$;
do $$
declare
  company uuid:='79000000-0000-4000-8000-000000000001'; operator uuid:='79000000-0000-4000-8000-0000000000aa';
  account uuid; invoice uuid; draft_invoice uuid; void_invoice uuid; r record; n_ledger int;
  pay text;
begin
  insert into orgs(id,slug,display_name) values(company,'payments-fixture','Synthetic payments drill');
  insert into accounts(id,org_id,name) values(gen_random_uuid(),company,'Synthetic payer') returning id into account;
  select id into account from accounts where org_id=company;
  perform seed_chart_of_accounts(company);
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents,issued_at,due_at)
    values(company,account,'PAY-1','issued','wholesale','NZD',10000,10000,now()-interval '2 days',now()+interval '12 days') returning id into invoice;
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents)
    values(company,account,'PAY-2','draft','wholesale','NZD',5000,5000) returning id into draft_invoice;
  -- A voided invoice now carries its evidence (0048 constraint).
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents,voided_at,voided_by,voided_reason)
    values(company,account,'PAY-3','void','wholesale','NZD',5000,5000,now(),'probe','void fixture') returning id into void_invoice;
  pay:=format('select * from operator_record_payment(%L,%L,4000,%L,%L,%L,%L)',company,invoice,now()-interval '1 day','BANK-REF-1',operator,'ops@example.test');

  -- Off until the business grants it (never seeded at boot); approve_required refused;
  -- pause and identity rules hold.
  perform pg_temp.pay_reject(pay,'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','payments.record','approve_required');
  perform pg_temp.pay_reject(pay,'%must not require approval%');
  update tool_grants set risk='notify' where org_id=company and tool_name='payments.record';
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.pay_reject(pay,'%business actions paused%');
  perform set_action_pause(company,false,'probe','probe resume');
  perform pg_temp.pay_reject(format('select * from operator_record_payment(%L,%L,4000,%L,%L,null,%L)',company,invoice,now(),'BANK-REF-1','ops@example.test'),'%operator identity required%');
  perform pg_temp.pay_reject(format('select * from operator_record_payment(%L,%L,4000,%L,%L,%L,%L)',company,invoice,now(),'x',operator,'ops@example.test'),'%payment reference required%');
  perform pg_temp.pay_reject(format('select * from operator_record_payment(%L,%L,0,%L,%L,%L,%L)',company,invoice,now(),'BANK-REF-1',operator,'ops@example.test'),'%amount must be positive%');
  perform pg_temp.pay_reject(format('select * from operator_record_payment(%L,%L,4000,%L,%L,%L,%L)',company,invoice,now()+interval '1 day','BANK-REF-1',operator,'ops@example.test'),'%must not be in the future%');
  perform pg_temp.pay_reject(format('select * from operator_record_payment(%L,%L,4000,%L,%L,%L,%L)',company,draft_invoice,now(),'BANK-REF-1',operator,'ops@example.test'),'%only an issued invoice%');
  perform pg_temp.pay_reject(format('select * from operator_record_payment(%L,%L,4000,%L,%L,%L,%L)',company,void_invoice,now(),'BANK-REF-1',operator,'ops@example.test'),'%void invoice cannot receive%');

  -- A partial payment lands once: posted to the ledger, the invoice turns partial, the
  -- payment carries the invoice's own currency, and posted_at guards re-posting.
  n_ledger:=(select count(*) from ledger_transactions where org_id=company and source='payment_received');
  execute pay into r;
  perform pg_temp.pay_assert(r.orp_invoice_state='partial' and not r.orp_was_existing,'first payment turns the invoice partial');
  perform pg_temp.pay_assert((select method='bank_transfer' and currency='NZD' and posted_at is not null and reference='BANK-REF-1'
    from payments where id=r.orp_payment_id),'payment stored in the invoice currency and posted');
  perform pg_temp.pay_assert((select count(*)=n_ledger+1 from ledger_transactions where org_id=company and source='payment_received'),'posted exactly once');
  perform pg_temp.pay_assert((select count(*)=1 from audit_log where org_id=company and action='payments.record'),'payment audited once');

  -- The same reference on the same invoice is a retry: same payment, no second posting,
  -- no second audit row. The same reference saying something different is refused.
  execute pay into r;
  perform pg_temp.pay_assert(r.orp_was_existing and r.orp_invoice_state='partial','retry adopts the stored payment');
  perform pg_temp.pay_assert((select count(*)=n_ledger+1 from ledger_transactions where org_id=company and source='payment_received'),'retry does not double-post');
  perform pg_temp.pay_assert((select count(*)=1 from audit_log where org_id=company and action='payments.record'),'retry not audited twice');
  perform pg_temp.pay_reject(format('select * from operator_record_payment(%L,%L,4100,%L,%L,%L,%L)',company,invoice,now()-interval '1 day','BANK-REF-1',operator,'ops@example.test'),'%conflicts with the stored payment%');

  -- The amount is capped at what is outstanding; settling the rest turns the invoice
  -- paid, and a paid invoice takes no further entries.
  perform pg_temp.pay_reject(format('select * from operator_record_payment(%L,%L,6001,%L,%L,%L,%L)',company,invoice,now(),'BANK-REF-2',operator,'ops@example.test'),'%exceeds what is outstanding%');
  select * into r from operator_record_payment(company,invoice,6000,now(),'BANK-REF-2',operator,'ops@example.test');
  perform pg_temp.pay_assert(r.orp_invoice_state='paid','settling the outstanding turns it paid');
  perform pg_temp.pay_reject(format('select * from operator_record_payment(%L,%L,100,%L,%L,%L,%L)',company,invoice,now(),'BANK-REF-3',operator,'ops@example.test'),'%already fully paid%');

  -- Another business's invoice is unreachable from here.
  perform pg_temp.pay_reject(format('select * from operator_record_payment(%L,%L,100,%L,%L,%L,%L)',company,
    (select id from invoices where org_id='63000000-0000-4000-8000-000000000001' limit 1),now(),'BANK-REF-X',operator,'ops@example.test'),'%invoice not found%');

  perform pg_temp.pay_assert(not has_function_privilege('anon','operator_record_payment(uuid,uuid,bigint,timestamptz,text,uuid,text)','execute')
    and not has_function_privilege('authenticated','operator_record_payment(uuid,uuid,bigint,timestamptz,text,uuid,text)','execute')
    and has_function_privilege('service_role','operator_record_payment(uuid,uuid,bigint,timestamptz,text,uuid,text)','execute'),
    'the payment entry point is service-only');
  raise notice 'OK: console bank payments — never-seeded grant, state/validity/outstanding rules, exactly-once posting, reference retry stability, audit and role probes';
end $$;
