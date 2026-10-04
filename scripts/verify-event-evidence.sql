\set ON_ERROR_STOP on
begin;
create function pg_temp.event_fixture(o uuid,id text,version integer default 1) returns jsonb language sql as $$
 select jsonb_build_object('event_id',id,'event_type','controller.invoice.drafted','event_version',1,
 'company_id',o,'connection_id',null,'occurred_at','2026-10-01T00:00:00Z','observed_at','2026-10-01T00:00:00Z',
 'producer','fixture','subject_type','Invoice','subject_id','synthetic-invoice','subject_version',version,
 'correlation_id','fixture-flow','causation_id',null,'source_refs','[]'::jsonb,'evidence_refs','[]'::jsonb,
 'event_class','fact','payload',jsonb_build_object('amount_minor','9007199254740993','revision',version))
$$;
create temporary table fixture_business_effects(id text primary key);
do $$
declare o uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); e jsonb; log_id uuid; c jsonb; c2 jsonb; denied boolean; n integer;
begin
 insert into orgs(id,slug,display_name) values(o,'events-'||o,'Wholesale fixture'),(b,'events-'||b,'Service fixture');
 e:=pg_temp.event_fixture(o,'one');
 -- Domain change + durable publication + receipts roll back as one unit.
 begin
   insert into fixture_business_effects values('aborted');
   perform publish_platform_event(o,e,'provider-1',array['test']);
   raise exception 'simulated transaction crash';
 exception when raise_exception then null; end;
 if exists(select 1 from platform_events where org_id=o) or exists(select 1 from event_receipts where org_id=o)
 or exists(select 1 from fixture_business_effects) then raise exception 'atomic publication rollback failed'; end if;
 log_id:=publish_platform_event(o,e,'provider-1',array['test']);
 if publish_platform_event(o,e,'provider-1',array['test'])<>log_id then raise exception 'delivery duplicated'; end if;
 if (select count(*) from event_log where id=log_id)<>1 or (select count(*) from event_receipts where org_id=o)<>1 then raise exception 'continuation missing/duplicated'; end if;
 denied:=false; begin perform publish_platform_event(o,jsonb_set(e,'{payload,amount_minor}','"4"'),'provider-1',array['test']); exception when others then denied:=true; end;
 if not denied then raise exception 'changed duplicate accepted'; end if;
 perform publish_platform_event(b,pg_temp.event_fixture(b,'one'),'provider-1',array['test']);
 perform publish_platform_event(o,jsonb_set(pg_temp.event_fixture(o,'connection-two'),'{connection_id}','"second"'),'provider-1',array['test']);
 denied:=false; begin perform publish_platform_event(o,jsonb_set(e,'{payload,ref}',jsonb_build_object('company_id',b)),'cross',array['test']); exception when others then denied:=true; end;
 if not denied then raise exception 'cross business reference accepted'; end if;
 if read_event_delivery(b,'connection-two') is not null then raise exception 'read leaked business'; end if;
 -- Claim survives caller loss; after expiry only a new fenced claimant can commit.
 c:=claim_event_receipt(o,'test');
 update event_receipts set lease_until=clock_timestamp()-interval '1 second' where org_id=o and event_id=c->>'event_id';
 c2:=claim_event_receipt(o,'test');
 if c2->>'event_id'<>c->>'event_id' or c2->>'lease_token'=c->>'lease_token' then raise exception 'recovery failed'; end if;
 denied:=false; begin perform apply_event_projection(o,'test','live',c->>'event_id',(c->>'lease_token')::uuid); exception when others then denied:=true; end;
 if not denied then raise exception 'stale worker committed'; end if;
 -- Crash inside projection transaction rolls back both projection and receipt.
 begin
   perform apply_event_projection(o,'test','live',c2->>'event_id',(c2->>'lease_token')::uuid);
   raise exception 'projection crash';
 exception when raise_exception then null; end;
 if exists(select 1 from event_read_models where org_id=o) then raise exception 'projection rollback failed'; end if;
 if apply_event_projection(o,'test','live',c2->>'event_id',(c2->>'lease_token')::uuid)<>'applied' then raise exception 'projection missing'; end if;
 perform apply_event_projection(o,'test','live',c2->>'event_id',(c2->>'lease_token')::uuid);
 -- Isolate ordered cases in another consumer; v3 cannot jump over v2.
 perform publish_platform_event(o,pg_temp.event_fixture(o,'one'),'provider-1',array['ordered']);
 c:=claim_event_receipt(o,'ordered'); perform apply_event_projection(o,'ordered','live',c->>'event_id',(c->>'lease_token')::uuid);
 perform publish_platform_event(o,pg_temp.event_fixture(o,'three',3),'provider-3',array['ordered']);
 c:=claim_event_receipt(o,'ordered');
 if apply_event_projection(o,'ordered','live','three',(c->>'lease_token')::uuid)<>'failed' then raise exception 'gap silently skipped'; end if;
 perform publish_platform_event(o,pg_temp.event_fixture(o,'two',2),'provider-2',array['ordered']);
 c:=claim_event_receipt(o,'ordered'); perform apply_event_projection(o,'ordered','live','two',(c->>'lease_token')::uuid);
 perform resume_event_receipt(o,'ordered','live','three','operator','predecessor restored');
 c:=claim_event_receipt(o,'ordered'); perform apply_event_projection(o,'ordered','live','three',(c->>'lease_token')::uuid);
 perform publish_platform_event(o,pg_temp.event_fixture(o,'old',1),'provider-old',array['ordered']);
 c:=claim_event_receipt(o,'ordered');
 if apply_event_projection(o,'ordered','live','old',(c->>'lease_token')::uuid)<>'ignored' then raise exception 'old arrival overwrote current'; end if;
 perform publish_platform_event(o,pg_temp.event_fixture(o,'conflict',3),'provider-conflict',array['ordered']);
 c:=claim_event_receipt(o,'ordered');
 if apply_event_projection(o,'ordered','live','conflict',(c->>'lease_token')::uuid)<>'quarantined' then raise exception 'same version conflict accepted'; end if;
 perform publish_platform_event(o,jsonb_set(pg_temp.event_fixture(o,'future'),'{event_version}','2'),'future',array['ordered']);
 if (select state from event_receipts where org_id=o and event_id='future')<>'quarantined' then raise exception 'unknown version not quarantined'; end if;
 perform publish_platform_event(o,jsonb_set(pg_temp.event_fixture(o,'unregistered'),'{event_type}','"fixture.unregistered"'),'unregistered',array['ordered']);
 if (select state from event_receipts where org_id=o and event_id='unregistered')<>'quarantined' then raise exception 'unknown type not quarantined'; end if;
 -- Port the archived candidate's retry exhaustion/resume case; also cover a lost
 -- final lease, which must quarantine without requiring a successful callback.
 perform publish_platform_event(o,pg_temp.event_fixture(o,'gap',9),'gap',array['bounded']);
 for n in 1..10 loop
   update event_receipts set next_attempt_at=clock_timestamp() where org_id=o and consumer='bounded';
   c:=claim_event_receipt(o,'bounded');
   perform apply_event_projection(o,'bounded','live','gap',(c->>'lease_token')::uuid);
 end loop;
 if (select state from event_receipts where org_id=o and consumer='bounded')<>'quarantined' then raise exception 'retry limit missing'; end if;
 perform resume_event_receipt(o,'bounded','live','gap','operator','source inspected');
 update event_receipts set attempts=9 where org_id=o and consumer='bounded';
 c:=claim_event_receipt(o,'bounded');
 update event_receipts set lease_until=clock_timestamp()-interval '1 second' where org_id=o and consumer='bounded';
 c:=claim_event_receipt(o,'bounded');
 if c is not null or (select state from event_receipts where org_id=o and consumer='bounded')<>'quarantined'
 then raise exception 'final crashed lease not quarantined'; end if;
 select count(*) into n from approved_actions where org_id=o;
 perform enqueue_event_replay(o,'ordered','rebuild-1',array['one','two','three']);
 for c in select jsonb_build_object('event_id',event_id) from event_receipts where org_id=o and generation='rebuild-1' order by event_id loop
   c2:=claim_event_receipt(o,'ordered','rebuild-1'); perform apply_event_projection(o,'ordered','rebuild-1',c2->>'event_id',(c2->>'lease_token')::uuid);
 end loop;
 if (select count(*) from approved_actions where org_id=o)<>n then raise exception 'replay created action'; end if;
 if has_function_privilege('anon','publish_platform_event(uuid,jsonb,text,text[])','execute')
 or has_table_privilege('service_role','event_receipts','update') then raise exception 'unsafe event grants'; end if;
end $$;

do $$
declare o uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); subject uuid:=gen_random_uuid(); obs jsonb; d jsonb; intent jsonb; a uuid; action uuid; claim jsonb; view jsonb; denied boolean; n integer; outcome jsonb; k text; bad jsonb;
begin
 insert into orgs(id,slug,display_name) values(o,'evidence-'||o,'Wholesale'),(b,'evidence-'||b,'Non-stock service');
 obs:=jsonb_build_object('contract_version',1,'company_id',o,'observation_id','obs','subject',jsonb_build_object('company_id',o,'type','Invoice','id',subject),'quality','verified',
 'created_at','2026-10-01T00:00:00Z','source','fixture','connection_id',null,'occurred_at','2026-10-01T00:00:00Z','observed_at','2026-10-01T00:00:00Z',
 'evidence_refs',jsonb_build_array(jsonb_build_object('company_id',o,'type','SourceRecord','id','fixture-source')));
 for k in select jsonb_object_keys(obs) loop
   denied:=false; begin perform record_evidence_observation(o,obs-k,'{}'); exception when others then denied:=true; end;
   if not denied then raise exception 'incomplete observation accepted: %',k; end if;
 end loop;
 perform record_evidence_observation(o,obs,'{"quantity":"40","amount_minor":"9007199254740993"}');
 d:=jsonb_build_object('contract_version',1,'company_id',o,'decision_id','decision','revision',1,
 'state_snapshot_ref',jsonb_build_object('company_id',o,'type','Snapshot','id','snapshot'),
 'trigger_refs',jsonb_build_array(jsonb_build_object('company_id',o,'type','Observation','id','obs')),
 'subject_refs',jsonb_build_array(jsonb_build_object('company_id',o,'type','Invoice','id',subject,'revision',1)),
 'created_at','2026-10-01T00:00:00Z','decision_type','controller.invoice_delivery','options_considered',jsonb_build_array('print','hold'),'recommended_option','print',
 'expected_outcomes',jsonb_build_array('available for packing'),'rationale','Synthetic fixture','assumptions','[]'::jsonb,'uncertainties',jsonb_build_array('packing unobserved'),
 'risk_class','B','policy_refs',jsonb_build_array(jsonb_build_object('company_id',o,'type','Policy','id','fixture-policy','revision',1)),
 'model_or_rule_provenance','fixture-rule-v1','expires_at','2026-10-07T00:00:00Z');
 for k in select jsonb_object_keys(d) loop
   denied:=false; begin perform record_evidence_decision(o,d-k,'{"subject_snapshot":{"revision":1}}'); exception when others then denied:=true; end;
   if not denied then raise exception 'incomplete decision accepted: %',k; end if;
 end loop;
 denied:=false; begin perform record_evidence_decision(o,jsonb_set(d,'{options_considered}','[1]'),'{}'); exception when others then denied:=true; end;
 if not denied then raise exception 'wrong decision array member accepted'; end if;
 denied:=false; begin perform record_evidence_decision(o,d||'{"unexpected":true}','{}'); exception when others then denied:=true; end;
 if not denied then raise exception 'unknown decision field accepted'; end if;
 perform record_evidence_decision(o,d,'{"subject_snapshot":{"revision":1},"quantity":"40","price_version":"synthetic-v1","amount_minor":"9007199254740993"}');
 denied:=false; begin perform record_evidence_decision(o,d,'{"quantity":"60"}'); exception when others then denied:=true; end;
 if not denied then raise exception 'decision evidence changed'; end if;
 denied:=false; begin update evidence_decisions set state_snapshot='{}' where org_id=o; exception when others then denied:=true; end;
 if not denied then raise exception 'immutable snapshot updated'; end if;
 insert into tool_grants(org_id,agent_name,tool_name,risk) values(o,'fixture','fixture.evidence','approve_required');
 intent:=jsonb_build_object('schema_version',1,'org_id',o,'agent_name','fixture','tool_name','fixture.evidence',
 'subject_type','invoice','subject_id',subject,'input','{}'::jsonb,'subject_snapshot','{"revision":1}'::jsonb,'policy_snapshot',null);
 a:=create_bound_approval(o,intent,now()+interval '1 hour');
 select count(*) into n from approvals where org_id=o;
 denied:=false;
 begin perform create_bound_approval(o,jsonb_set(intent,'{input}',jsonb_build_object('oversize',repeat('x',270000))),now()+interval '1 hour');
 exception when others then denied:=true; end;
 if not denied or (select count(*) from approvals where org_id=o)<>n or (select count(*) from approved_actions where org_id=o)<>1
 then raise exception 'publication failure did not roll back authority mutation'; end if;
 select id into action from approved_actions where approval_id=a;
 bad:=jsonb_set(jsonb_set(jsonb_set(d,'{decision_id}','"wrong-revision"'),'{state_snapshot_ref,id}','"wrong-revision-snapshot"'),'{subject_refs,0,revision}','2');
 perform record_evidence_decision(o,bad,'{"subject_snapshot":{"revision":1}}');
 denied:=false; begin perform link_decision_action(o,'wrong-revision',1,action); exception when others then denied:=true; end;
 if not denied then raise exception 'substituted subject revision linked'; end if;
 bad:=jsonb_set(jsonb_set(d,'{decision_id}','"wrong-material"'),'{state_snapshot_ref,id}','"wrong-material-snapshot"');
 perform record_evidence_decision(o,bad,'{"subject_snapshot":{"revision":1,"amount_minor":"1"}}');
 denied:=false; begin perform link_decision_action(o,'wrong-material',1,action); exception when others then denied:=true; end;
 if not denied then raise exception 'changed material snapshot linked'; end if;
 perform link_decision_action(o,'decision',1,action);
 view:=read_decision_evidence(o,'decision',1);
 if view#>>'{actions,0,execution_status}'<>'pending' or view->>'outcome_status'<>'unknown' then raise exception 'missing state fabricated'; end if;
 if read_decision_evidence(b,'decision',1) is not null then raise exception 'decision read leaks'; end if;
 denied:=false; begin perform link_decision_action(b,'decision',1,action); exception when others then denied:=true; end;
 if not denied then raise exception 'cross-business action linked'; end if;
 perform decide_bound_approval(o,a,'approved','fixture-operator');
 claim:=claim_bound_action(o,a,'fixture-worker','null','{"revision":1}');
 perform finish_bound_action(o,action,(claim->>'execution_id')::uuid,'UNRESOLVED',null,null,'provider timeout');
 view:=read_decision_evidence(o,'decision',1);
 if view#>>'{actions,0,execution_status}'<>'unknown' then raise exception 'uncertainty hidden'; end if;
 denied:=false; begin perform claim_bound_action(o,a,'worker','null','{"revision":1}'); exception when others then denied:=true; end;
 if not denied then raise exception 'unknown business effect retried'; end if;
 perform reconcile_bound_action(o,action,'FAILED','reconciliation-owner','{"provider_lookup":"confirmed_absent"}');
 if read_decision_evidence(o,'decision',1)#>>'{actions,0,execution_status}'<>'failed' then raise exception 'known failure hidden'; end if;
 if not exists(select 1 from evidence_history where org_id=o and record_kind='attempt' and record->>'state'='UNRESOLVED') then raise exception 'reconciliation erased uncertainty'; end if;
 if not exists(select 1 from platform_events where org_id=o and event_type='platform.attempt.state_recorded') then raise exception 'attempt continuation absent'; end if;
 select count(*) into n from evidence_history where org_id=o;
 update approved_actions set updated_at=clock_timestamp() where id=action;
 if (select count(*) from evidence_history where org_id=o)<>n then raise exception 'no-op created history'; end if;
 outcome:=jsonb_build_object('contract_version',1,'company_id',o,'outcome_id','unknown-result','decision_id','decision','action_ids',jsonb_build_array(action),
 'status','unknown','unknown_reason','Cash collection unobserved','evaluation','unavailable','metrics_after','[]'::jsonb,'observed_outcomes','[]'::jsonb,'measured_at',null,
 'created_at','2026-10-01T00:00:00Z','measurement_window',jsonb_build_object('start','2026-10-01T00:00:00Z','end','2026-10-07T00:00:00Z'),
 'metrics_before','[]'::jsonb,'expected_outcomes',jsonb_build_array('available for packing'),'confounders','[]'::jsonb,'evidence_refs','[]'::jsonb);
 for k in select jsonb_object_keys(outcome) loop
   denied:=false; begin perform record_evidence_outcome(o,1,outcome-k); exception when others then denied:=true; end;
   if not denied then raise exception 'incomplete outcome accepted: %',k; end if;
 end loop;
 denied:=false; begin perform record_evidence_outcome(o,1,jsonb_set(outcome,'{measurement_window,end}','"2026-09-30T00:00:00Z"')); exception when others then denied:=true; end;
 if not denied then raise exception 'reversed outcome window accepted'; end if;
 perform record_evidence_outcome(o,1,outcome);
 denied:=false; begin perform record_evidence_outcome(o,1,jsonb_set(outcome,'{metrics_after}','[{"name":"cash","value":"100","unit":"NZD"}]')); exception when others then denied:=true; end;
 if not denied then raise exception 'unknown outcome fabricated metrics'; end if;
 if read_decision_evidence(o,'decision',1)#>>'{state_at_decision,amount_minor}'<>'9007199254740993' then raise exception 'historical money changed'; end if;
 -- Trigger failure aborts originating authority mutation and its attempt evidence.
 begin
   perform claim_bound_action(o,a,'worker','null','{"revision":1}');
   raise exception 'crash after claim inside transaction';
 exception when raise_exception then null; end;
 if (select count(*) from action_attempts where org_id=o)<>1 then raise exception 'crashed claim survived'; end if;
 if has_function_privilege('authenticated','read_decision_evidence(uuid,text,integer)','execute')
 or has_table_privilege('service_role','evidence_history','insert') then raise exception 'unsafe evidence grants'; end if;
end $$;
rollback;
\echo 'OK: event atomicity, dedup/scope, fencing, gaps, replay, immutable evidence, unknown recovery, native transition linkage'
