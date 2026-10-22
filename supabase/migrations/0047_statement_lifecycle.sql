-- CLOSE-01b: the statement lifecycle becomes an operator responsibility. 0015 declared
-- draft → sent → voided and 0044 let the console generate drafts, but nothing could move
-- the state: "sent" was a column with no writer, and a superseded snapshot stayed
-- indistinguishable from the live one. Sending itself remains the human's act (VICE
-- prints or emails the document; automatic sending has not been delegated) — these entry
-- points record the business fact afterwards, the same shape as recording an invoice
-- print (0034): identity, pause and the operator grant enforced, the row's evidence
-- columns stamped, an audit row, exact-retry stability without double audit.
--
-- statements.record_send and statements.void are seeded notify-tier at boot: recording
-- that a person sent a document and retiring a read-projection snapshot move no money
-- and change no ledger fact. A voided statement keeps its immutable figures and its
-- lines; only its lifecycle says it must not be relied on.

alter table statements add column sent_by text;
alter table statements add column voided_at timestamptz;
alter table statements add column voided_by text;
alter table statements add column voided_reason text;
comment on column statements.sent_by is 'Operator email that recorded the statement as sent (0047). The send itself is a human act outside Atlas.';
comment on column statements.voided_reason is 'Why the statement was retired (0047). The snapshot stays immutable; only its lifecycle changes.';

-- A voided statement carries when/why; a sent one carries when/by whom. Enforced at the
-- database so no writer can leave the lifecycle half-stamped.
alter table statements add constraint statements_lifecycle_evidence check (
  (state <> 'voided' or (voided_at is not null and voided_reason is not null))
  and (state <> 'sent' or sent_at is not null)
  and (state = 'voided' or (voided_at is null and voided_by is null and voided_reason is null))
);

create function operator_record_statement_sent(p_org_id uuid,p_statement_id uuid,p_actor_id uuid,p_actor_email text)
returns table(orss_state statement_state,orss_sent_at timestamptz)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_st statements%rowtype;
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','statements.record_send');
  if exists(select 1 from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='statements.record_send'
    and risk='approve_required') then raise exception 'recording a send cannot itself require an approval; its grant must not require approval'; end if;
  select * into v_st from statements where org_id=p_org_id and id=p_statement_id for update;
  if not found then raise exception 'statement not found'; end if;
  if v_st.state='voided' then raise exception 'statement already voided'; end if;
  -- Exact retry: the fact is already recorded; return it without a second audit row.
  if v_st.state='sent' then return query select v_st.state,v_st.sent_at; return; end if;

  update statements set state='sent',sent_at=clock_timestamp(),sent_by=trim(p_actor_email)
    where id=v_st.id returning * into v_st;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','statements.record_send','statements.record_send','statement',v_st.id,'notify','success',
      jsonb_build_object('actor_id',p_actor_id,'actor_email',trim(p_actor_email),'account_id',v_st.account_id,
        'sent_at',v_st.sent_at));
  return query select v_st.state,v_st.sent_at;
end $$;

create function operator_void_statement(p_org_id uuid,p_statement_id uuid,p_reason text,p_actor_id uuid,p_actor_email text)
returns table(ovs_state statement_state,ovs_voided_at timestamptz)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_st statements%rowtype; v_reason text:=trim(coalesce(p_reason,''));
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  if length(v_reason)<3 then raise exception 'void reason required'; end if;
  if length(v_reason)>500 then raise exception 'void reason too long'; end if;
  perform assert_action_authority(p_org_id,'operator','statements.void');
  if exists(select 1 from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='statements.void'
    and risk='approve_required') then raise exception 'voiding a statement cannot itself require an approval; its grant must not require approval'; end if;
  select * into v_st from statements where org_id=p_org_id and id=p_statement_id for update;
  if not found then raise exception 'statement not found'; end if;
  if v_st.state='voided' then
    -- Exact retry (same reason) returns the recorded fact; a different reason is a
    -- different request and must not silently rewrite why.
    if v_st.voided_reason=v_reason then return query select v_st.state,v_st.voided_at; return; end if;
    raise exception 'statement already voided';
  end if;

  update statements set state='voided',voided_at=clock_timestamp(),voided_by=trim(p_actor_email),voided_reason=v_reason
    where id=v_st.id returning * into v_st;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','statements.void','statements.void','statement',v_st.id,'notify','success',
      jsonb_build_object('actor_id',p_actor_id,'actor_email',trim(p_actor_email),'account_id',v_st.account_id,
        'was_state',case when v_st.sent_at is null then 'draft' else 'sent' end,'reason',v_reason,'voided_at',v_st.voided_at));
  return query select v_st.state,v_st.voided_at;
end $$;

do $$ declare r text; f regprocedure; begin
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('operator_record_statement_sent','operator_void_statement') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
