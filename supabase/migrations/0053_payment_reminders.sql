-- CLOSE-01f: payment reminders. The receivables page (CLOSE-01e) shows who is late; this
-- drafts the reminder an operator sends them. A reminder is a snapshot of one retailer's
-- overdue invoices in one currency, as of the moment it was drafted and in the business's
-- calendar: each invoice's number, the date it aged from, days late and what is still
-- owed (total less recorded payments), counted by the same overdue_days the statements
-- use (0020). The snapshot never changes; its text is rendered from it.
--
-- Sending stays the human's act, as for statements (0047): Atlas drafts, the operator
-- sends it by email, print or phone, then records that (with the channel and a note) —
-- or voids a draft that should not go, with a reason. One open draft per retailer and
-- currency: a newer picture needs the old draft sent or voided first. The three grants
-- are seeded notify-tier at boot: drafting derives from stored records, and recording or
-- retiring a reminder moves no money. Service-role only.

create table payment_reminders (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete restrict,
  account_id uuid not null,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  as_of_at timestamptz not null,
  timezone text not null,
  lines jsonb not null check (jsonb_typeof(lines) = 'array' and jsonb_array_length(lines) between 1 and 500),
  overdue_cents bigint not null check (overdue_cents > 0),
  state text not null default 'draft' check (state in ('draft', 'sent', 'voided')),
  drafted_by text not null,
  actor_id uuid not null,
  created_at timestamptz not null default now(),
  sent_at timestamptz,
  sent_by text,
  sent_channel text check (sent_channel is null or sent_channel in ('email', 'print', 'phone', 'other')),
  sent_note text check (sent_note is null or length(sent_note) <= 500),
  voided_at timestamptz,
  voided_by text,
  voided_reason text check (voided_reason is null or length(voided_reason) between 3 and 500),
  unique (org_id, id),
  foreign key (org_id, account_id) references accounts(org_id, id) on delete restrict,
  -- A sent reminder carries when, by whom and how; a voided one when and why. Nothing
  -- can leave the lifecycle half-stamped.
  constraint payment_reminders_lifecycle_evidence check (
    (state <> 'draft' or (sent_at is null and sent_channel is null and voided_at is null))
    and (state <> 'sent' or (sent_at is not null and sent_by is not null and sent_channel is not null))
    and (state <> 'voided' or (voided_at is not null and voided_by is not null and voided_reason is not null))
  )
);
create unique index payment_reminders_one_draft on payment_reminders(org_id, account_id, currency) where state = 'draft';
create index payment_reminders_recent on payment_reminders(org_id, created_at desc);
comment on table payment_reminders is
  'A retailer''s overdue invoices as of a moment, drafted as a reminder (0053). The snapshot is fixed; sending is a human act recorded afterwards.';

create function payment_reminders_snapshot_fixed() returns trigger language plpgsql as $$
begin
  if tg_op = 'DELETE' then raise exception 'payment reminders are kept'; end if;
  if (new.org_id, new.account_id, new.currency, new.as_of_at, new.timezone, new.lines, new.overdue_cents,
      new.drafted_by, new.actor_id, new.created_at)
     is distinct from (old.org_id, old.account_id, old.currency, old.as_of_at, old.timezone, old.lines, old.overdue_cents,
      old.drafted_by, old.actor_id, old.created_at) then
    raise exception 'a payment reminder''s contents are fixed';
  end if;
  return new;
end $$;
create trigger payment_reminders_snapshot_fixed before update or delete on payment_reminders
  for each row execute function payment_reminders_snapshot_fixed();

do $$ declare r text; begin
  alter table payment_reminders enable row level security;
  revoke all on payment_reminders from public;
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on payment_reminders from %I', r);
      if r='service_role' then grant select on payment_reminders to service_role; end if;
    end if;
  end loop;
end $$;

create function operator_draft_payment_reminder(p_org_id uuid,p_account_id uuid,p_currency text,p_timezone text,
  p_actor_id uuid,p_actor_email text)
returns table(odr_reminder_id uuid,odr_was_existing boolean)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_currency text:=upper(trim(coalesce(p_currency,''))); v_tz text:=coalesce(nullif(trim(coalesce(p_timezone,'')),''),'Pacific/Auckland');
  v_now timestamptz:=clock_timestamp(); v_lines jsonb; v_total bigint; v_id uuid; v_existing uuid;
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','reminders.generate');
  if exists(select 1 from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='reminders.generate'
    and enabled and risk='approve_required') then
    raise exception 'drafting a reminder cannot itself require an approval; its grant must not require approval'; end if;
  if v_currency !~ '^[A-Z]{3}$' then raise exception 'reminder currency must be a three-letter code'; end if;
  if not exists(select 1 from pg_timezone_names where name=v_tz) then raise exception 'unknown timezone'; end if;
  if not exists(select 1 from accounts where org_id=p_org_id and id=p_account_id) then raise exception 'retailer not found'; end if;

  -- One open draft per retailer and currency: a retry returns it.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':reminder:'||p_account_id::text||':'||v_currency,0));
  select id into v_existing from payment_reminders
    where org_id=p_org_id and account_id=p_account_id and currency=v_currency and state='draft';
  if found then return query select v_existing,true; return; end if;

  -- Overdue as statements age it: from the due date, or the issue date without one, in
  -- calendar days in the business's timezone; owed is the total less recorded payments.
  select jsonb_agg(jsonb_build_object(
           'invoice_id',o.id,'invoice_number',o.invoice_number,'aged_from',o.aged_from,
           'anchor_on',to_char(o.anchor at time zone v_tz,'YYYY-MM-DD'),'days_late',o.days,
           'outstanding_cents',o.owed::text) order by o.days desc,o.invoice_number),
         sum(o.owed)
    into v_lines,v_total
    from (
      select i.id,i.invoice_number,coalesce(i.due_at,i.issued_at) as anchor,
             case when i.due_at is null then 'issued' else 'due' end as aged_from,
             overdue_days(coalesce(i.due_at,i.issued_at),v_now,v_tz) as days,
             i.total_cents-coalesce((select sum(p.amount_cents) from payments p where p.org_id=i.org_id and p.invoice_id=i.id),0) as owed
        from invoices i
       where i.org_id=p_org_id and i.account_id=p_account_id and i.currency=v_currency
         and i.state in ('issued','partial') and coalesce(i.due_at,i.issued_at) is not null
    ) o
   where o.days>0 and o.owed>0;
  if v_lines is null then raise exception 'nothing is overdue for this retailer in this currency'; end if;

  insert into payment_reminders(org_id,account_id,currency,as_of_at,timezone,lines,overdue_cents,drafted_by,actor_id)
    values(p_org_id,p_account_id,v_currency,v_now,v_tz,v_lines,v_total,trim(p_actor_email),p_actor_id)
    returning id into v_id;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','reminders.generate','reminders.generate','payment_reminder',v_id,'notify','success',jsonb_build_object(
      'actor_id',p_actor_id,'actor_email',trim(p_actor_email),'account_id',p_account_id,'currency',v_currency,
      'invoices',jsonb_array_length(v_lines),'overdue_cents',v_total::text,'as_of_at',v_now,'timezone',v_tz));
  return query select v_id,false;
end $$;

create function operator_record_reminder_sent(p_org_id uuid,p_reminder_id uuid,p_channel text,p_note text,
  p_actor_id uuid,p_actor_email text) returns timestamptz
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_r payment_reminders%rowtype; v_note text:=nullif(trim(coalesce(p_note,'')),'');
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','reminders.record_send');
  if exists(select 1 from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='reminders.record_send'
    and enabled and risk='approve_required') then
    raise exception 'recording a send cannot itself require an approval; its grant must not require approval'; end if;
  if p_channel is null or p_channel not in ('email','print','phone','other') then raise exception 'reminder channel required'; end if;
  if length(coalesce(v_note,''))>500 then raise exception 'reminder note too long'; end if;
  select * into v_r from payment_reminders where org_id=p_org_id and id=p_reminder_id for update;
  if not found then raise exception 'reminder not found'; end if;
  if v_r.state='voided' then raise exception 'reminder already voided'; end if;
  if v_r.state='sent' then
    -- Exact retry: the fact is already recorded. A different channel is a different claim.
    if v_r.sent_channel=p_channel then return v_r.sent_at; end if;
    raise exception 'reminder already recorded as sent';
  end if;
  update payment_reminders set state='sent',sent_at=clock_timestamp(),sent_by=trim(p_actor_email),sent_channel=p_channel,sent_note=v_note
    where id=v_r.id returning * into v_r;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','reminders.record_send','reminders.record_send','payment_reminder',v_r.id,'notify','success',
      jsonb_build_object('actor_id',p_actor_id,'actor_email',trim(p_actor_email),'account_id',v_r.account_id,
        'channel',p_channel,'note',v_note,'sent_at',v_r.sent_at));
  return v_r.sent_at;
end $$;

create function operator_void_payment_reminder(p_org_id uuid,p_reminder_id uuid,p_reason text,p_actor_id uuid,p_actor_email text)
returns timestamptz
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_r payment_reminders%rowtype; v_reason text:=trim(coalesce(p_reason,''));
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  if length(v_reason)<3 then raise exception 'void reason required'; end if;
  if length(v_reason)>500 then raise exception 'void reason too long'; end if;
  perform assert_action_authority(p_org_id,'operator','reminders.void');
  if exists(select 1 from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='reminders.void'
    and enabled and risk='approve_required') then
    raise exception 'voiding a reminder cannot itself require an approval; its grant must not require approval'; end if;
  select * into v_r from payment_reminders where org_id=p_org_id and id=p_reminder_id for update;
  if not found then raise exception 'reminder not found'; end if;
  if v_r.state='voided' then
    if v_r.voided_reason=v_reason then return v_r.voided_at; end if;
    raise exception 'reminder already voided';
  end if;
  -- A sent reminder went out: it is history, not something to retract.
  if v_r.state='sent' then raise exception 'a sent reminder cannot be voided'; end if;
  update payment_reminders set state='voided',voided_at=clock_timestamp(),voided_by=trim(p_actor_email),voided_reason=v_reason
    where id=v_r.id returning * into v_r;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','reminders.void','reminders.void','payment_reminder',v_r.id,'notify','success',
      jsonb_build_object('actor_id',p_actor_id,'actor_email',trim(p_actor_email),'account_id',v_r.account_id,
        'reason',v_reason,'voided_at',v_r.voided_at));
  return v_r.voided_at;
end $$;

-- The entry points are service-only; the trigger fires without EXECUTE.
do $$ declare r text; f regprocedure; v_entry boolean; begin
  for f, v_entry in select oid::regprocedure, proname<>'payment_reminders_snapshot_fixed' from pg_proc
    where pronamespace='public'::regnamespace and proname in ('operator_draft_payment_reminder','operator_record_reminder_sent',
      'operator_void_payment_reminder','payment_reminders_snapshot_fixed') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' and v_entry then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
