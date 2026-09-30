-- AUTH owns 0027 by the integration coordinator's 1 October reservation.
-- Serialize final invoice effects across distinct actions, then re-read aggregate
-- policy state. Approval and an earlier TS evaluation do not reserve headroom.
create or replace function issue_bound_invoice(p_org_id uuid,p_action_id uuid,p_execution_id uuid) returns jsonb
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v approved_actions%rowtype; a approvals%rowtype; i invoices%rowtype;
 r record; cfg jsonb; spent numeric; actions bigint; hours numeric;
begin
 -- READ COMMITTED callers acquire the lock before taking fresh statement snapshots.
 -- Stronger snapshot isolation is refused: a transaction snapshot predating the
 -- previous issuer would otherwise hide its consumption after waiting for this lock.
 if current_setting('transaction_isolation') <> 'read committed' then
   raise exception 'bound issuance requires read committed isolation';
 end if;
 perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':controller.issue_invoice',0));
 select * into v from approved_actions where org_id=p_org_id and id=p_action_id for update;
 if not found or v.intent->>'tool_name'<>'controller.issue_invoice' or v.state<>'EXECUTING' or v.revoked_at is not null
 then raise exception 'invalid invoice action'; end if;
 select * into a from approvals where org_id=p_org_id and id=v.approval_id for update;
 if a.state<>'approved' or a.expires_at<=clock_timestamp() then raise exception 'approval expired or invalid'; end if;
 if not exists(select 1 from action_attempts where org_id=p_org_id and action_id=v.id and id=p_execution_id and state='EXECUTING')
 then raise exception 'attempt not active'; end if;
 perform assert_action_authority(p_org_id,a.agent_name,a.action);
 -- Lock the existing authority rows against concurrent revocation through commit.
 perform 1 from tool_grants where org_id=p_org_id and agent_name=a.agent_name and tool_name=a.action for share;
 perform 1 from agents where org_id=p_org_id and name=a.agent_name for share;
 perform 1 from action_controls where org_id=p_org_id for share;
 perform assert_action_authority(p_org_id,a.agent_name,a.action);
 perform 1 from policy_rules where org_id=p_org_id and scope_action=a.action for share;
 if current_action_policy(p_org_id,a.action) is distinct from v.intent->'policy_snapshot' then raise exception 'policy changed'; end if;
 cfg:=v.intent#>'{policy_snapshot,config}';
 select * into i from invoices where org_id=p_org_id and id=a.subject_id for update;
 if not found or i.state<>'draft' or invoice_action_snapshot(p_org_id,a.subject_id) is distinct from v.intent->'subject_snapshot'
 then raise exception 'invoice changed'; end if;
 -- Verify canonical inputs inside the effect transaction as well as in the tool adapter.
 if v.intent->>'subject_type' is distinct from 'invoice'
 or v.intent#>>'{input,invoiceId}' is distinct from i.id::text
 or v.intent#>>'{input,amount,$atlas_bigint}' is distinct from i.total_cents::text
 or v.intent#>>'{input,currency}' is distinct from i.currency
 or v.intent#>>'{input,accountId}' is distinct from i.account_id::text
 or v.intent#>>'{input,fulfillmentEventId}' is distinct from i.fulfillment_event_id::text
 then raise exception 'invoice inputs do not match approved material subject'; end if;
 if cfg ? 'perTransactionCap' then
   if (cfg#>>'{perTransactionCap,amount}') is null or i.total_cents > (cfg#>>'{perTransactionCap,amount}')::numeric
   then raise exception 'current policy per-transaction cap blocks action'; end if;
 end if;
 if cfg ? 'rollingWindow' then
   hours:=(cfg#>>'{rollingWindow,windowHours}')::numeric;
   if hours is null or hours<=0 or (cfg#>>'{rollingWindow,amount}') is null then raise exception 'invalid rolling policy'; end if;
   select coalesce(sum(total_cents),0) into spent from invoices
    where org_id=p_org_id and state in ('issued','paid','partial') and currency=i.currency
    and issued_at >= clock_timestamp() - hours * interval '1 hour';
   if spent+i.total_cents > (cfg#>>'{rollingWindow,amount}')::numeric then raise exception 'current policy rolling-window cap blocks action'; end if;
 end if;
 if cfg ? 'velocityLimit' then
   hours:=(cfg#>>'{velocityLimit,windowHours}')::numeric;
   if hours is null or hours<=0 or (cfg#>>'{velocityLimit,maxActions}') is null then raise exception 'invalid velocity policy'; end if;
   select count(*) into actions from invoices where org_id=p_org_id and state in ('issued','paid','partial')
    and issued_at >= clock_timestamp() - hours * interval '1 hour';
   if actions+1 > (cfg#>>'{velocityLimit,maxActions}')::numeric then raise exception 'current policy velocity limit blocks action'; end if;
 end if;
 -- The existing conditional source contract carries no verified monetary amount.
 -- Keep it closed until a domain adapter supplies an atomic verified contract.
 if coalesce((cfg#>>'{conditionalGate,requirePrecondition}')::boolean,false) then
   raise exception 'conditional source policy requires an atomic verified source adapter';
 end if;
 select * into r from issue_invoice_atomic(p_org_id,a.subject_id,v.idempotency_key);
 update outbox set state='failed',last_error='provider action requires separate bound authorization' where id=r.outbox_id and org_id=p_org_id;
 return to_jsonb(r);
end $$;

-- Legacy unbound RPC remains for migration-owner probes only. Runtime must use the
-- bound SECURITY DEFINER wrapper, which revalidates all authority before calling it.
revoke execute on function issue_invoice_atomic(uuid,uuid,text) from public,anon,authenticated,service_role;
revoke all on function issue_bound_invoice(uuid,uuid,uuid) from public,anon,authenticated;
grant execute on function issue_bound_invoice(uuid,uuid,uuid) to service_role;
