-- CLOSE-01c invoice void (0048): grant/approve_required/pause/identity/reason rules,
-- the issued-only and no-recorded-payments refusals, the exact ledger reversal (the
-- invoice's postings net to zero per account), statement exclusion after the void,
-- exact-retry stability without a second reversal or audit, the webhook payment guard
-- on post_payment_received, cross-business isolation with the rival fully granted, and
-- role privileges.
create function pg_temp.void_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT INVOICE VOID: %',msg; end if; end $$;
create function pg_temp.void_reject(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like pattern then raise; end if; return; end;
  raise exception 'ASSERT INVOICE VOID expected rejection: %',pattern;
end $$;
do $$
declare
  company uuid:='83000000-0000-4000-8000-000000000001'; rival uuid:='83000000-0000-4000-8000-000000000002';
  operator uuid:='83000000-0000-4000-8000-0000000000aa';
  account uuid; inv_void uuid; inv_paid uuid; inv_draft uuid; r record; stmt record; voidcmd text; late_payment uuid;
begin
  insert into orgs(id,slug,display_name) values
    (company,'void-fixture','Synthetic void drill'),(rival,'void-rival','Synthetic void rival');
  insert into accounts(org_id,name) values(company,'Synthetic void payer') returning id into account;
  perform seed_chart_of_accounts(company);

  -- A draft issued through the real path, so its ledger posting exists to reverse; a
  -- second issued invoice that receives a payment; and a draft that stays a draft.
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,tax_cents,total_cents,due_at)
    values(company,account,'VOID-1','draft','wholesale','NZD',17391,2609,20000,now()+interval '20 days') returning id into inv_void;
  perform issue_invoice_atomic(company,inv_void,'void-probe-issue-1');
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,tax_cents,total_cents,due_at)
    values(company,account,'VOID-2','draft','wholesale','NZD',26087,3913,30000,now()+interval '20 days') returning id into inv_paid;
  perform issue_invoice_atomic(company,inv_paid,'void-probe-issue-2');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','payments.record','notify');
  perform operator_record_payment(company,inv_paid,10000,now()-interval '1 day','VOID-BANK-1',operator,'ops@example.test');
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents)
    values(company,account,'VOID-3','draft','wholesale','NZD',5000,5000) returning id into inv_draft;
  voidcmd:=format('select * from operator_void_invoice(%L,%L,%L,%L,%L)',company,inv_void,'issued against the wrong retailer',operator,'ops@example.test');

  -- Off until granted (never seeded); approve_required refused; pause and identity hold.
  perform pg_temp.void_reject(voidcmd,'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','invoices.void','approve_required');
  perform pg_temp.void_reject(voidcmd,'%must not require approval%');
  update tool_grants set risk='notify' where org_id=company and tool_name='invoices.void';
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.void_reject(voidcmd,'%business actions paused%');
  perform set_action_pause(company,false,'probe','probe resume');
  perform pg_temp.void_reject(format('select * from operator_void_invoice(%L,%L,%L,null,%L)',company,inv_void,'no identity','ops@example.test'),
    '%operator identity required%');
  perform pg_temp.void_reject(format('select * from operator_void_invoice(%L,%L,%L,%L,%L)',company,inv_void,'  ',operator,'ops@example.test'),
    '%void reason required%');
  perform pg_temp.void_reject(format('select * from operator_void_invoice(%L,%L,%L,%L,%L)',company,inv_void,repeat('x',501),operator,'ops@example.test'),
    '%void reason too long%');

  -- Only an issued invoice without payments: a draft, a partially paid invoice and a
  -- cross-business reach (rival fully granted) are each refused by name.
  perform pg_temp.void_reject(format('select * from operator_void_invoice(%L,%L,%L,%L,%L)',company,inv_draft,'draft probe',operator,'ops@example.test'),
    '%only an issued invoice can be voided%');
  perform pg_temp.void_reject(format('select * from operator_void_invoice(%L,%L,%L,%L,%L)',company,inv_paid,'paid probe',operator,'ops@example.test'),
    '%recorded payments cannot be voided%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(rival,'operator','invoices.void','notify');
  perform pg_temp.void_reject(format('select * from operator_void_invoice(%L,%L,%L,%L,%L)',rival,inv_void,'cross-business probe',operator,'ops@example.test'),
    '%invoice not found%');

  -- The void lands: state, evidence, the reversal transaction, and the invoice's ledger
  -- netting to zero on every account it touched. Audited once.
  select * into r from operator_void_invoice(company,inv_void,'issued against the wrong retailer',operator,'ops@example.test');
  perform pg_temp.void_assert(r.ovi_state='void' and r.ovi_voided_at is not null and r.ovi_reversal_transaction_id is not null,
    'void transitions and returns its reversal');
  perform pg_temp.void_assert((select state='void' and voided_by='ops@example.test' and voided_reason='issued against the wrong retailer'
    from invoices where id=inv_void),'void evidence stamped on the row');
  perform pg_temp.void_assert((select count(*)=2 from ledger_transactions where org_id=company and source_ref=inv_void and source_ref_type='invoice'),
    'the reversal is its own transaction beside the issue posting');
  perform pg_temp.void_assert(not exists(
    select 1 from ledger_lines l join ledger_transactions t on t.id=l.transaction_id
      where t.org_id=company and t.source_ref=inv_void and t.source_ref_type='invoice'
      group by l.ledger_account_id having sum(l.amount_cents)<>0),
    'every account the invoice posted to nets to zero after the reversal');
  perform pg_temp.void_assert((select count(*)=1 from audit_log where org_id=company and action='invoices.void'),'void audited once');

  -- Exact retry returns the recorded fact: no second reversal, no second audit; a
  -- different reason is refused, never silently rewritten.
  select * into r from operator_void_invoice(company,inv_void,'issued against the wrong retailer',operator,'ops@example.test');
  perform pg_temp.void_assert(r.ovi_state='void' and r.ovi_voided_at=(select voided_at from invoices where id=inv_void)
    and r.ovi_reversal_transaction_id is not null,'void retry returns the recorded fact');
  perform pg_temp.void_assert((select count(*)=2 from ledger_transactions where org_id=company and source_ref=inv_void and source_ref_type='invoice'),
    'retry posts no second reversal');
  perform pg_temp.void_assert((select count(*)=1 from audit_log where org_id=company and action='invoices.void'),'retry not audited twice');
  perform pg_temp.void_reject(format('select * from operator_void_invoice(%L,%L,%L,%L,%L)',company,inv_void,'a different story',operator,'ops@example.test'),
    '%invoice already voided%');

  -- Future statements exclude the voided invoice: closing is VOID-2 outstanding only.
  select * into stmt from generate_statement_atomic(company,account,now()-interval '30 days',clock_timestamp(),'probe','Pacific/Auckland');
  perform pg_temp.void_assert(stmt.closing_balance_cents=20000,'statement closing excludes the voided invoice');

  -- No payment can reach the voided invoice: the operator path refuses, and the webhook
  -- path (post_payment_received) now refuses instead of resurrecting the receivable.
  perform pg_temp.void_reject(format('select * from operator_record_payment(%L,%L,%L,clock_timestamp(),%L,%L,%L)',
    company,inv_void,1000,'VOID-LATE-1',operator,'ops@example.test'),'%void invoice cannot receive a payment%');
  insert into payments(org_id,invoice_id,amount_cents,currency,method,received_at)
    values(company,inv_void,1000,'NZD','stripe',now()) returning id into late_payment;
  perform pg_temp.void_reject(format('select * from post_payment_received(%L,%L)',company,late_payment),
    '%void invoice cannot receive a payment%');
  perform pg_temp.void_assert((select state='void' from invoices where id=inv_void),'the voided invoice stays void');

  perform pg_temp.void_assert(not has_function_privilege('anon','operator_void_invoice(uuid,uuid,text,uuid,text)','execute')
    and not has_function_privilege('authenticated','operator_void_invoice(uuid,uuid,text,uuid,text)','execute')
    and has_function_privilege('service_role','operator_void_invoice(uuid,uuid,text,uuid,text)','execute'),
    'the void entry point is service-only');
  raise notice 'OK: invoice void — grant/approve_required/pause/identity/reason, issued-only and payments refusals, exact ledger reversal, statement exclusion, retry stability, webhook guard, isolation and role probes';
end $$;
