\set ON_ERROR_STOP on
begin;
-- A valid DecisionV1 proposal: publication validates the payload itself.
create function pg_temp.event_fixture(o uuid,id text,version integer default 1,decision text default 'synthetic-decision') returns jsonb language sql as $$
 select jsonb_build_object('event_id',id,'event_type','controller.decision.proposed','event_version',1,
 'company_id',o,'connection_id',null,'occurred_at','2026-10-01T00:00:00Z','observed_at','2026-10-01T00:00:00Z',
 'producer','fixture','subject_type','Decision','subject_id',decision,'subject_version',version,
 'correlation_id','fixture-flow','causation_id',null,'source_refs','[]'::jsonb,'evidence_refs','[]'::jsonb,
 'event_class','proposal','payload',jsonb_build_object('contract_version',1,'company_id',o,'created_at','2026-10-01T00:00:00Z',
   'decision_id',decision,'revision',version,'decision_type','controller.invoice_delivery',
   'subject_refs',jsonb_build_array(jsonb_build_object('company_id',o,'type','Invoice','id','synthetic-invoice')),
   'trigger_refs',jsonb_build_array(jsonb_build_object('company_id',o,'type','Observation','id','obs')),
   'state_snapshot_ref',jsonb_build_object('company_id',o,'type','Snapshot','id','snapshot-'||version),
   'options_considered',jsonb_build_array('print','hold'),'recommended_option','print','expected_outcomes',jsonb_build_array('available for packing'),
   'rationale','Synthetic amount 9007199254740993','assumptions','[]'::jsonb,'uncertainties','[]'::jsonb,'risk_class','B',
   'policy_refs',jsonb_build_array(jsonb_build_object('company_id',o,'type','Policy','id','fixture-policy')),
   'model_or_rule_provenance','fixture-rule-v1','expires_at','2026-10-07T00:00:00Z'))
$$;
create function pg_temp.execution_fixture(o uuid,id text,revision integer,state text) returns jsonb language sql as $$
 select jsonb_build_object('event_id',id,'event_type','controller.action.execution_recorded','event_version',1,
 'company_id',o,'connection_id',null,'occurred_at','2026-10-01T00:00:00Z','observed_at','2026-10-01T00:00:00Z',
 'producer','fixture','subject_type','Execution','subject_id','exec-1','subject_version',revision,
 'correlation_id','fixture-flow','causation_id',null,'source_refs','[]'::jsonb,'evidence_refs','[]'::jsonb,
 'event_class','fact','payload',jsonb_build_object('contract_version',1,'company_id',o,'created_at','2026-10-01T00:00:00Z',
   'execution_id','exec-1','revision',revision,'action_id','act-1','action_revision',1,'attempt_number',1,'idempotency_key','act-1:1',
   'connection_id',null,'state',state,'started_at','2026-10-01T00:00:00Z',
   'finished_at',case when state='EXECUTING' then null else '2026-10-01T00:01:00Z' end,'provider_reference',null,
   'result',case when state='CONFIRMED' then 'document_generated' else 'unknown' end,
   'evidence_refs',case when state='CONFIRMED' then jsonb_build_array(jsonb_build_object('company_id',o,'type','Artifact','id','pdf-1')) else '[]'::jsonb end,
   'error_code',null,'reconciliation_owner',null))
$$;
create temporary table fixture_business_effects(id text primary key);
do $$
declare o uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); e jsonb; log_id uuid; c jsonb; c2 jsonb; denied boolean; n integer; k text;
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
 denied:=false; begin perform publish_platform_event(o,jsonb_set(e,'{payload,rationale}','"changed"'),'provider-1',array['test']); exception when others then denied:=true; end;
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
 -- Payloads are validated at publication; a type without a SQL validator is not projected.
 denied:=false; begin perform publish_platform_event(o,jsonb_set(pg_temp.event_fixture(o,'skeletal'),'{payload}',
   jsonb_build_object('contract_version',1,'company_id',o,'decision_id','synthetic-decision','revision',1)),'skeletal',array['ordered']);
 exception when others then denied:=true; end;
 if not denied then raise exception 'skeletal decision payload accepted'; end if;
 perform publish_platform_event(o,jsonb_set(jsonb_set(pg_temp.event_fixture(o,'drafted'),'{event_type}','"controller.invoice.drafted"'),
   '{payload}','{"total_cents":-5,"garbage":true}'),'drafted',array['ordered']);
 if (select state from event_receipts where org_id=o and event_id='drafted')<>'quarantined' then raise exception 'unvalidated invoice.drafted projected'; end if;
 -- An execution's later state is its next revision, not a same-version conflict.
 perform publish_platform_event(o,pg_temp.execution_fixture(o,'exec-executing',1,'EXECUTING'),'exec-1',array['executions']);
 perform publish_platform_event(o,pg_temp.execution_fixture(o,'exec-confirmed',2,'CONFIRMED'),'exec-2',array['executions']);
 for n in 1..2 loop
   c:=claim_event_receipt(o,'executions');
   if apply_event_projection(o,'executions','live',c->>'event_id',(c->>'lease_token')::uuid)<>'applied' then raise exception 'execution state % not applied',n; end if;
 end loop;
 if (select (payload->>'state')||':'||subject_version from event_read_models where org_id=o and consumer='executions')<>'CONFIRMED:2'
 then raise exception 'execution did not advance to its confirmed revision'; end if;
 denied:=false; begin perform publish_platform_event(o,jsonb_set(pg_temp.execution_fixture(o,'exec-bad',3,'CONFIRMED'),'{payload,evidence_refs}','[]'),'exec-3',array['executions']);
 exception when others then denied:=true; end;
 if not denied then raise exception 'confirmation without evidence accepted'; end if;
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
 if exists(select 1 from event_receipts where org_id=o and generation='rebuild-1' and state<>'applied') then raise exception 'rebuild did not apply in order'; end if;
 -- Eleven versions whose ids sort in reverse still rebuild in version order, spending one
 -- attempt each (before, v11 quarantined at the attempt limit).
 for n in 1..11 loop perform publish_platform_event(o,pg_temp.event_fixture(o,'desc-'||(100-n),n,'descending'),'desc-'||n,'{}'); end loop;
 perform enqueue_event_replay(o,'ordered','rebuild-desc',array(select 'desc-'||(100-x) from generate_series(1,11) x));
 for n in 1..11 loop
   c2:=claim_event_receipt(o,'ordered','rebuild-desc');
   if apply_event_projection(o,'ordered','rebuild-desc',c2->>'event_id',(c2->>'lease_token')::uuid)<>'applied' then raise exception 'descending rebuild out of order at %',n; end if;
 end loop;
 if (select subject_version from event_read_models where org_id=o and consumer='ordered' and generation='rebuild-desc')<>11
 or exists(select 1 from event_receipts where org_id=o and generation='rebuild-desc' and (state<>'applied' or attempts<>1))
 then raise exception 'descending rebuild wasted attempts or stalled'; end if;
 -- A successor claimed while its predecessor is still in flight waits without spending an attempt.
 perform enqueue_event_replay(o,'ordered','rebuild-wait',array['desc-99','desc-98']);
 c:=claim_event_receipt(o,'ordered','rebuild-wait');
 c2:=claim_event_receipt(o,'ordered','rebuild-wait');
 if c->>'event_id'<>'desc-99' or c2->>'event_id'<>'desc-98' then raise exception 'claims not in version order'; end if;
 -- Separate statements: a sub-select in the same expression would read pre-update data.
 k:=apply_event_projection(o,'ordered','rebuild-wait','desc-98',(c2->>'lease_token')::uuid);
 if k<>'pending' or (select attempts from event_receipts where org_id=o and generation='rebuild-wait' and event_id='desc-98')<>0
 then raise exception 'successor spent an attempt waiting for its predecessor'; end if;
 perform apply_event_projection(o,'ordered','rebuild-wait','desc-99',(c->>'lease_token')::uuid);
 update event_receipts set next_attempt_at=clock_timestamp() where org_id=o and generation='rebuild-wait' and event_id='desc-98';
 c2:=claim_event_receipt(o,'ordered','rebuild-wait');
 if apply_event_projection(o,'ordered','rebuild-wait','desc-98',(c2->>'lease_token')::uuid)<>'applied' then raise exception 'successor not applied after predecessor'; end if;
 if (select count(*) from approved_actions where org_id=o)<>n then raise exception 'replay created action'; end if;
 if has_function_privilege('anon','publish_platform_event(uuid,jsonb,text,text[])','execute')
 or has_table_privilege('service_role','event_receipts','update') then raise exception 'unsafe event grants'; end if;
end $$;

do $$
declare o uuid:=gen_random_uuid(); b uuid:=gen_random_uuid(); subject uuid:=gen_random_uuid(); obs jsonb; d jsonb; intent jsonb; a uuid; action uuid; claim jsonb; view jsonb; denied boolean; n integer; outcome jsonb; k text; bad jsonb;
 inv uuid; snap jsonb; invoice_action uuid; a2 uuid;
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
 -- Every recorded AUTH row is published, including the approval that predates its action.
 if (select count(*) from evidence_history where org_id=o)<>(select count(*) from platform_events where org_id=o and event_type like 'platform.%.state_recorded')
 or not exists(select 1 from platform_events where org_id=o and event_type='platform.approval.state_recorded')
 then raise exception 'native evidence not fully published'; end if;
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
 -- A real invoice snapshot ({invoice, lines}, no revision) links by its exact material state.
 insert into invoices(org_id,invoice_number,currency,subtotal_cents,total_cents,state)
 values(o,'evidence-fixture','NZD',9007199254740993,9007199254740993,'draft') returning id into inv;
 snap:=invoice_action_snapshot(o,inv);
 a2:=create_bound_approval(o,jsonb_set(jsonb_set(jsonb_set(intent,'{subject_id}',to_jsonb(inv)),'{subject_snapshot}',snap),'{input}','{"invoice":true}'),now()+interval '1 hour');
 select id into invoice_action from approved_actions where approval_id=a2;
 bad:=jsonb_set(jsonb_set(jsonb_set(d,'{decision_id}','"invoice-decision"'),'{state_snapshot_ref,id}','"invoice-snapshot"'),
   '{subject_refs,0}',jsonb_build_object('company_id',o,'type','Invoice','id',inv,'revision',1));
 perform record_evidence_decision(o,bad,jsonb_build_object('subject_snapshot',snap));
 perform link_decision_action(o,'invoice-decision',1,invoice_action);
 bad:=jsonb_set(jsonb_set(bad,'{decision_id}','"invoice-decision-stale"'),'{state_snapshot_ref,id}','"invoice-snapshot-stale"');
 perform record_evidence_decision(o,bad,jsonb_build_object('subject_snapshot',jsonb_set(snap,'{invoice,total_cents}','"1"')));
 denied:=false; begin perform link_decision_action(o,'invoice-decision-stale',1,invoice_action); exception when others then denied:=true; end;
 if not denied then raise exception 'stale invoice snapshot linked'; end if;
 view:=read_decision_evidence(o,'decision',1);
 if view#>>'{actions,0,execution_status}'<>'pending' or view->>'outcome_status'<>'unknown' then raise exception 'missing state fabricated'; end if;
 if read_decision_evidence(b,'decision',1) is not null then raise exception 'decision read leaks'; end if;
 denied:=false; begin perform link_decision_action(b,'decision',1,action); exception when others then denied:=true; end;
 if not denied then raise exception 'cross-business action linked'; end if;
 perform decide_bound_approval(o,a,'approved','fixture-operator');
 claim:=claim_bound_action(o,a,'fixture-worker','null','{"revision":1}');
 -- A provider result naming its own company, or too large to publish, is still recorded:
 -- kept whole in history, published as a digest.
 perform finish_bound_action(o,action,(claim->>'execution_id')::uuid,'UNRESOLVED',
   jsonb_build_object('provider',jsonb_build_object('company_id',b,'org_id','acct_123'),'body',repeat('x',270000)),null,'provider timeout');
 if not exists(select 1 from evidence_history where org_id=o and record_kind='attempt' and record#>>'{result,provider,org_id}'='acct_123')
 or not exists(select 1 from platform_events where org_id=o and event_type='platform.attempt.state_recorded'
   and envelope#>>'{payload,record,result,sha256}' ~ '^[0-9a-f]{64}$')
 then raise exception 'provider result not kept whole and published as digest'; end if;
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
 if exists(select 1 from event_receipts where org_id=o) then raise exception 'native evidence left receipts nothing drains'; end if;
 if has_function_privilege('authenticated','read_decision_evidence(uuid,text,integer)','execute')
 or has_table_privilege('service_role','evidence_history','insert') then raise exception 'unsafe evidence grants'; end if;
end $$;
rollback;
\echo 'OK: event atomicity, dedup/scope, payload validation, fencing, gaps, ordered replay, execution revisions, immutable evidence, unknown recovery, native transition linkage'
