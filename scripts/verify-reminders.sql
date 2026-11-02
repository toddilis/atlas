-- CLOSE-01f payment reminders (0053): grant/pause/identity, the overdue snapshot (aged as
-- statements age it, net of payments, one currency), one open draft per retailer and
-- currency, the fixed snapshot, record-sent and void lifecycles with their evidence,
-- cross-business reach and role privileges — against a real disposable database.
create function pg_temp.rem_assert(ok boolean,msg text) returns void language plpgsql as $$
begin if ok is distinct from true then raise exception 'ASSERT REMINDERS: %',msg; end if; end $$;
create function pg_temp.rem_reject(command text,pattern text) returns void language plpgsql as $$
begin
  begin execute command; exception when others then if sqlerrm not like pattern then raise; end if; return; end;
  raise exception 'ASSERT REMINDERS expected rejection: %',pattern;
end $$;
do $$
declare
  company uuid:='88000000-0000-4000-8000-000000000001'; other uuid:='88000000-0000-4000-8000-000000000002';
  operator uuid:='88000000-0000-4000-8000-0000000000aa'; email text:='ops@example.test';
  late uuid; quiet uuid; foreign_acct uuid; part_paid uuid; paid_off uuid; r record; first_id uuid; aud_id uuid; v_at timestamptz;
  draft text;
begin
  insert into orgs(id,slug,display_name) values(company,'reminder-fixture','Synthetic reminders drill'),(other,'reminder-other','Other reminders drill');
  insert into accounts(org_id,name) values(company,'Late Retailer') returning id into late;
  insert into accounts(org_id,name) values(company,'Quiet Retailer') returning id into quiet;
  insert into accounts(org_id,name) values(other,'Other business retailer') returning id into foreign_acct;
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents,issued_at,due_at) values
    (company,late,'REM-1','issued','wholesale','NZD',10000,10000,now()-interval '70 days',now()-interval '40 days'),
    (company,late,'REM-3','issued','wholesale','NZD',4000,4000,now()-interval '5 days',now()+interval '25 days'),
    (company,late,'REM-4','issued','wholesale','AUD',3000,3000,now()-interval '60 days',now()-interval '30 days'),
    (company,late,'REM-5','issued','wholesale','NZD',2500,2500,now()-interval '100 days',null),
    (company,quiet,'REM-8','issued','wholesale','NZD',900,900,now()-interval '3 days',now()+interval '27 days'),
    (company,late,'REM-9','draft','wholesale','NZD',800,800,null,null);
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents,issued_at,due_at)
    values(company,late,'REM-2','partial','wholesale','NZD',5000,5000,now()-interval '40 days',now()-interval '10 days') returning id into part_paid;
  insert into payments(org_id,invoice_id,amount_cents,currency,method,received_at) values(company,part_paid,2000,'NZD','bank_transfer',now()-interval '2 days');
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents,issued_at,due_at)
    values(company,late,'REM-7','partial','wholesale','NZD',1000,1000,now()-interval '50 days',now()-interval '20 days') returning id into paid_off;
  insert into payments(org_id,invoice_id,amount_cents,currency,method,received_at) values(company,paid_off,1000,'NZD','bank_transfer',now()-interval '1 day');
  insert into invoices(org_id,account_id,invoice_number,state,channel,currency,subtotal_cents,total_cents,issued_at,due_at,voided_at,voided_by,voided_reason)
    values(company,late,'REM-6','void','wholesale','NZD',700,700,now()-interval '60 days',now()-interval '30 days',now(),'probe','void fixture');
  draft:='select * from operator_draft_payment_reminder(%L,%L,%L,%L,%L,%L)';

  -- Off until granted; approve_required refused; pause and identity hold.
  perform pg_temp.rem_reject(format(draft,company,late,'NZD','Pacific/Auckland',operator,email),'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','reminders.generate','approve_required');
  perform pg_temp.rem_reject(format(draft,company,late,'NZD','Pacific/Auckland',operator,email),'%must not require approval%');
  update tool_grants set risk='notify' where org_id=company and tool_name='reminders.generate';
  perform set_action_pause(company,true,'probe','probe pause');
  perform pg_temp.rem_reject(format(draft,company,late,'NZD','Pacific/Auckland',operator,email),'%business actions paused%');
  perform set_action_pause(company,false,'probe','probe resume');
  perform pg_temp.rem_reject(format(draft,company,late,'NZD','Pacific/Auckland',null,email),'%operator identity required%');
  perform pg_temp.rem_reject(format(draft,company,late,'NZ','Pacific/Auckland',operator,email),'%three-letter code%');
  perform pg_temp.rem_reject(format(draft,company,late,'NZD','Mars/Olympus',operator,email),'%unknown timezone%');
  perform pg_temp.rem_reject(format(draft,company,foreign_acct,'NZD','Pacific/Auckland',operator,email),'%retailer not found%');
  perform pg_temp.rem_reject(format(draft,company,quiet,'NZD','Pacific/Auckland',operator,email),'%nothing is overdue%');

  -- The snapshot: overdue NZD invoices only, latest first, net of payments; not the
  -- future-due, other-currency, draft, void or fully paid ones; no due date ages from issue.
  execute format(draft,company,late,'nzd','Pacific/Auckland',operator,email) into r;
  first_id:=r.odr_reminder_id;
  perform pg_temp.rem_assert(not r.odr_was_existing,'a first draft is new');
  perform pg_temp.rem_assert((select overdue_cents=15500 and currency='NZD' and timezone='Pacific/Auckland' and state='draft'
    and jsonb_array_length(lines)=3 from payment_reminders where id=first_id),'three overdue invoices, 155.00 owed');
  perform pg_temp.rem_assert((select array_agg(l->>'invoice_number' order by ord)=array['REM-5','REM-1','REM-2']
    from payment_reminders, jsonb_array_elements(lines) with ordinality e(l,ord) where id=first_id),'latest first');
  perform pg_temp.rem_assert((select (l->>'outstanding_cents')='3000' and (l->>'aged_from')='due' and (l->>'days_late')::int between 9 and 11
    from payment_reminders, jsonb_array_elements(lines) l where id=first_id and l->>'invoice_number'='REM-2'),'part-paid is owed net');
  perform pg_temp.rem_assert((select (l->>'aged_from')='issued' and (l->>'days_late')::int>=99
    from payment_reminders, jsonb_array_elements(lines) l where id=first_id and l->>'invoice_number'='REM-5'),'no due date ages from issue');

  -- One open draft per retailer and currency: a retry returns it, unaudited; another
  -- currency is its own reminder.
  execute format(draft,company,late,'NZD','Pacific/Auckland',operator,email) into r;
  perform pg_temp.rem_assert(r.odr_was_existing and r.odr_reminder_id=first_id,'a retry returns the open draft');
  perform pg_temp.rem_assert((select count(*)=1 from audit_log where org_id=company and action='reminders.generate'),'drafted once');
  execute format(draft,company,late,'AUD','Pacific/Auckland',operator,email) into r;
  aud_id:=r.odr_reminder_id;
  perform pg_temp.rem_assert((select overdue_cents=3000 and jsonb_array_length(lines)=1 from payment_reminders where id=aud_id),'the AUD reminder stands alone');

  -- The snapshot is fixed and kept.
  perform pg_temp.rem_reject(format('update payment_reminders set overdue_cents=1 where id=%L',first_id),'%contents are fixed%');
  perform pg_temp.rem_reject(format('delete from payment_reminders where id=%L',first_id),'%are kept%');
  perform pg_temp.rem_reject(format('update payment_reminders set state=%L where id=%L','sent',first_id),'%payment_reminders_lifecycle_evidence%');

  -- Recording the send: granted separately, a channel required; an exact retry returns
  -- the fact; another channel is refused; a sent reminder is not voided.
  perform pg_temp.rem_reject(format('select operator_record_reminder_sent(%L,%L,%L,%L,%L,%L)',company,first_id,'email','sent from Gmail',operator,email),'%tool entitlement missing or revoked%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(company,'operator','reminders.record_send','notify'),(company,'operator','reminders.void','notify');
  perform pg_temp.rem_reject(format('select operator_record_reminder_sent(%L,%L,%L,%L,%L,%L)',company,first_id,'carrier pigeon',null,operator,email),'%channel required%');
  v_at:=operator_record_reminder_sent(company,first_id,'email','sent from Gmail',operator,email);
  perform pg_temp.rem_assert((select state='sent' and sent_at=v_at and sent_by=email and sent_channel='email' and sent_note='sent from Gmail'
    from payment_reminders where id=first_id),'the send is recorded with its evidence');
  perform pg_temp.rem_assert(operator_record_reminder_sent(company,first_id,'email',null,operator,email)=v_at,'an exact retry returns the fact');
  perform pg_temp.rem_assert((select count(*)=1 from audit_log where org_id=company and action='reminders.record_send'),'recorded once');
  perform pg_temp.rem_reject(format('select operator_record_reminder_sent(%L,%L,%L,%L,%L,%L)',company,first_id,'print',null,operator,email),'%already recorded as sent%');
  perform pg_temp.rem_reject(format('select operator_void_payment_reminder(%L,%L,%L,%L,%L)',company,first_id,'changed my mind',operator,email),'%sent reminder cannot be voided%');

  -- Once the old one is sent, a newer picture can be drafted.
  execute format(draft,company,late,'NZD','Pacific/Auckland',operator,email) into r;
  perform pg_temp.rem_assert(not r.odr_was_existing and r.odr_reminder_id<>first_id,'a new draft after the send');

  -- Voiding a draft: a reason required; an exact retry returns it; a voided reminder is not sent.
  perform pg_temp.rem_reject(format('select operator_void_payment_reminder(%L,%L,%L,%L,%L)',company,aud_id,'no',operator,email),'%void reason required%');
  v_at:=operator_void_payment_reminder(company,aud_id,'Retailer paid by card',operator,email);
  perform pg_temp.rem_assert((select state='voided' and voided_at=v_at and voided_reason='Retailer paid by card' from payment_reminders where id=aud_id),'voided with its reason');
  perform pg_temp.rem_assert(operator_void_payment_reminder(company,aud_id,'Retailer paid by card',operator,email)=v_at,'an exact void retry returns the fact');
  perform pg_temp.rem_reject(format('select operator_void_payment_reminder(%L,%L,%L,%L,%L)',company,aud_id,'Another reason',operator,email),'%already voided%');
  perform pg_temp.rem_reject(format('select operator_record_reminder_sent(%L,%L,%L,%L,%L,%L)',company,aud_id,'email',null,operator,email),'%already voided%');

  -- Another business's reminder is unreachable.
  perform pg_temp.rem_reject(format('select operator_record_reminder_sent(%L,%L,%L,%L,%L,%L)',other,first_id,'email',null,operator,email),'%tool entitlement missing%');
  insert into tool_grants(org_id,agent_name,tool_name,risk) values(other,'operator','reminders.record_send','notify');
  perform pg_temp.rem_reject(format('select operator_record_reminder_sent(%L,%L,%L,%L,%L,%L)',other,first_id,'email',null,operator,email),'%reminder not found%');

  perform pg_temp.rem_assert(
    has_function_privilege('service_role','operator_draft_payment_reminder(uuid,uuid,text,text,uuid,text)','execute')
    and not has_function_privilege('authenticated','operator_draft_payment_reminder(uuid,uuid,text,text,uuid,text)','execute')
    and has_function_privilege('service_role','operator_record_reminder_sent(uuid,uuid,text,text,uuid,text)','execute')
    and not has_function_privilege('anon','operator_record_reminder_sent(uuid,uuid,text,text,uuid,text)','execute')
    and has_function_privilege('service_role','operator_void_payment_reminder(uuid,uuid,text,uuid,text)','execute')
    and has_table_privilege('service_role','payment_reminders','select')
    and not has_table_privilege('service_role','payment_reminders','update')
    and not has_table_privilege('authenticated','payment_reminders','select'),
    'entry points are service-only; the table is read-only to the service');
  raise notice 'OK: payment reminders — grants/pause/identity, the overdue snapshot net of payments in the business calendar, one open draft per retailer and currency, a fixed snapshot, send and void lifecycles with evidence, isolation and role probes';
end $$;
