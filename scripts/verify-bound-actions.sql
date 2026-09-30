\set ON_ERROR_STOP on
begin;
do $$
declare
 o uuid:=gen_random_uuid(); other_org uuid:=gen_random_uuid(); subject uuid:=gen_random_uuid();
 a uuid; act uuid; claim jsonb; intent jsonb; i uuid; snap jsonb; issued jsonb; denied boolean;
begin
 insert into orgs(id,slug,display_name) values(o,'bound-'||o,'Bound fixture'),(other_org,'bound-'||other_org,'Other fixture');
 insert into tool_grants(org_id,agent_name,tool_name,risk) values(o,'fixture','fixture.action','approve_required'),(o,'controller','controller.issue_invoice','approve_required');
 intent:=jsonb_build_object('schema_version',1,'org_id',o,'agent_name','fixture','tool_name','fixture.action','subject_type','fixture','subject_id',subject,
   'input',jsonb_build_object('amount',jsonb_build_object('$atlas_bigint','9007199254740993')),'subject_snapshot','{"revision":1}'::jsonb,'policy_snapshot',null);
 a:=create_bound_approval(o,intent,clock_timestamp()+interval '0.1 second','expiry fixture');
 perform decide_bound_approval(o,a,'approved','operator');
 perform pg_sleep(0.15);
 denied:=false; begin perform claim_bound_action(o,a,'worker','null','{"revision":1}'); exception when others then denied:=true; end;
 if not denied then raise exception 'expired approval executed'; end if;
 a:=create_bound_approval(o,intent,now()+interval '1 hour','fixture');
 select id into act from approved_actions where approval_id=a;
 if (select approved_actions.intent#>>'{input,amount,$atlas_bigint}' from approved_actions where id=act)<>'9007199254740993' then raise exception 'amount lost precision'; end if;
 denied:=false; begin perform decide_bound_approval(other_org,a,'approved','operator'); exception when others then denied:=true; end;
 if not denied then raise exception 'cross-company decision allowed'; end if;
 perform decide_bound_approval(o,a,'approved','operator');
 denied:=false; begin perform claim_bound_action(o,a,'worker','null','{"revision":2}'); exception when others then denied:=true; end;
 if not denied then raise exception 'changed subject allowed'; end if;
 update tool_grants set enabled=false where org_id=o and tool_name='fixture.action';
 denied:=false; begin perform claim_bound_action(o,a,'worker','null','{"revision":1}'); exception when others then denied:=true; end;
 if not denied then raise exception 'revoked grant executed'; end if;
 update tool_grants set enabled=true where org_id=o and tool_name='fixture.action';
 perform set_action_pause(o,true,'operator','fixture pause');
 denied:=false; begin perform claim_bound_action(o,a,'worker','null','{"revision":1}'); exception when others then denied:=true; end;
 if not denied then raise exception 'paused business executed'; end if;
 perform set_action_pause(o,false,'operator','fixture resume');
 claim:=claim_bound_action(o,a,'worker','null','{"revision":1}');
 denied:=false; begin perform claim_bound_action(o,a,'worker','null','{"revision":1}'); exception when others then denied:=true; end;
 if not denied then raise exception 'duplicate claim executed'; end if;
 perform finish_bound_action(o,act,(claim->>'execution_id')::uuid,'UNRESOLVED',null,null,'timeout');
 denied:=false; begin perform claim_bound_action(o,a,'worker','null','{"revision":1}'); exception when others then denied:=true; end;
 if not denied then raise exception 'uncertain result retried'; end if;
 perform reconcile_bound_action(o,act,'FAILED','operator','{"provider_lookup":"confirmed_absent"}');
 claim:=claim_bound_action(o,a,'worker','null','{"revision":1}');
 if (select count(*) from action_attempts where action_id=act)<>2 then raise exception 'retry attempt missing'; end if;
 if claim->>'idempotency_key'<>(select idempotency_key from approved_actions where id=act) then raise exception 'effect identity changed'; end if;
 perform finish_bound_action(o,act,(claim->>'execution_id')::uuid,'CONFIRMED','{"ok":true}','{"record":"fixture-result"}');
 denied:=false; begin update approved_actions set intent=jsonb_set(approved_actions.intent,'{input,amount}','"forged"') where id=act; exception when others then denied:=true; end;
 if not denied then raise exception 'immutable intent edited'; end if;
 denied:=false; begin update approvals set payload='{}' where id=a; exception when others then denied:=true; end;
 if not denied then raise exception 'approval payload edited'; end if;
 if (select count(*) from audit_log where approval_id=a)<6 then raise exception 'transition evidence incomplete'; end if;

 a:=create_bound_approval(o,intent,now()+interval '1 hour');
 select id into act from approved_actions where approval_id=a;
 perform decide_bound_approval(o,a,'approved','operator');
 perform revoke_bound_action(o,act,'operator','changed decision');
 denied:=false; begin perform claim_bound_action(o,a,'worker','null','{"revision":1}'); exception when others then denied:=true; end;
 if not denied then raise exception 'revoked approval executed'; end if;

 a:=create_bound_approval(o,intent,now()+interval '1 hour');
 perform decide_bound_approval(o,a,'approved','operator');
 insert into policy_rules(org_id,scope_action,config) values(o,'fixture.action','{"approvalThreshold":{"amount":"1"}}');
 denied:=false; begin perform claim_bound_action(o,a,'worker','null','{"revision":1}'); exception when others then denied:=true; end;
 if not denied then raise exception 'new policy ignored'; end if;

 insert into invoices(org_id,invoice_number,currency,subtotal_cents,total_cents,state)
 values(o,'bound-fixture','NZD',9007199254740993,9007199254740993,'draft') returning id into i;
 snap:=invoice_action_snapshot(o,i);
 if snap#>>'{invoice,total_cents}'<>'9007199254740993' or jsonb_typeof(snap#>'{invoice,total_cents}')<>'string'
 then raise exception 'invoice money not lossless'; end if;
 intent:=jsonb_build_object('schema_version',1,'org_id',o,'agent_name','controller','tool_name','controller.issue_invoice',
 'subject_type','invoice','subject_id',i,'input','{}'::jsonb,'subject_snapshot',snap,'policy_snapshot',null);
 a:=create_bound_approval(o,intent,now()+interval '1 hour');
 perform decide_bound_approval(o,a,'approved','operator');
 update invoices set total_cents=100 where id=i;
 denied:=false; begin perform claim_bound_action(o,a,'worker','null',snap); exception when others then denied:=true; end;
 if not denied then raise exception 'stale invoice claim allowed'; end if;

 -- The exact stored invoice executes once, with local ledger evidence and held delivery.
 perform seed_chart_of_accounts(o);
 insert into invoices(org_id,invoice_number,currency,subtotal_cents,total_cents,state,channel)
 values(o,'bound-issuance','NZD',1000,1000,'draft','wholesale') returning id into i;
 snap:=invoice_action_snapshot(o,i);
 intent:=jsonb_set(jsonb_set(intent,'{subject_id}',to_jsonb(i)),'{subject_snapshot}',snap);
 intent:=jsonb_set(intent,'{input}',jsonb_build_object('invoiceId',i,'amount',jsonb_build_object('$atlas_bigint','1000'),
   'currency','NZD','accountId',null,'fulfillmentEventId',null));
 a:=create_bound_approval(o,intent,now()+interval '1 hour');
 perform decide_bound_approval(o,a,'approved','operator');
 claim:=claim_bound_action(o,a,'worker','null',snap);
 act:=(claim->>'action_id')::uuid;
 issued:=issue_bound_invoice(o,act,(claim->>'execution_id')::uuid);
 if (select state from invoices where id=i)<>'issued' or issued->>'ledger_transaction_id' is null
 then raise exception 'local issuance evidence missing'; end if;
 if (select state from outbox where id=(issued->>'outbox_id')::uuid)<>'failed'
 then raise exception 'provider delivery not held'; end if;
 denied:=false; begin insert into invoice_lines(org_id,invoice_id,description,quantity,unit_price_cents,total_cents)
 values(o,i,'unauthorized post-issue edit',1,1,1); exception when others then denied:=true; end;
 if not denied then raise exception 'issued line snapshot mutated'; end if;
 denied:=false; begin perform issue_bound_invoice(o,act,(claim->>'execution_id')::uuid); exception when others then denied:=true; end;
 if not denied then raise exception 'invoice issued twice'; end if;
 perform finish_bound_action(o,act,(claim->>'execution_id')::uuid,'CONFIRMED',issued,jsonb_build_object('invoice',i,'delivery','not_confirmed'));

 if has_function_privilege('authenticated','claim_bound_action(uuid,uuid,text,jsonb,jsonb)','execute')
 or has_function_privilege('anon','create_bound_approval(uuid,jsonb,timestamp with time zone,text)','execute')
 or has_table_privilege('service_role','approved_actions','update')
 then raise exception 'bound-action role boundary grants unsafe access'; end if;
end $$;
rollback;
\echo 'OK: bound approval exact intent, scope, revocation, policy/pause, claim/recovery and evidence probes'
