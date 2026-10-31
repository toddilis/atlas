-- FLOW-01B: the bank import as a shared platform source (PLAN D18). Every imported bank
-- line is kept verbatim and append-only — the Bookkeeper module later codes the lines
-- the Controller does not consume — and the Controller's receivables leg matches credit
-- lines to outstanding invoices through the existing exactly-once payment path (0043).
-- A bank line never disappears silently: it is unmatched, matched to the payment it
-- created, or deliberately set aside with a reason.
--
-- Synthetic interim format now; the real Wise/ASB export becomes an adapter when the
-- sample arrives (its format is the contract, per the queue). Lines deduplicate by
-- content (account, day, amount, reference, description), so re-imports and overlapping
-- exports never double a line. Two literally identical lines in one export collapse to
-- one — a stated interim limit; the real adapter keys on the bank's own transaction id.
--
-- Grants: bank.import is NEVER seeded at boot (entering external financial facts is a
-- deliberate business switch, like payments.record, and approve_required is refused
-- outright). Matching enforces payments.record — it IS a payment entry. bank.review
-- (set aside / reopen, no money moved) is seeded notify-tier.

create table bank_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete restrict,
  name text not null check (name = trim(name) and length(name) between 1 and 120),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  created_by text not null,
  created_at timestamptz not null default now(),
  unique (org_id, name), unique (org_id, id)
);
comment on table bank_accounts is 'A bank source identity (0051): one per real account (e.g. Wise NZD, ASB). Shared with Bookkeeper (D18).';

create table bank_imports (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete restrict,
  bank_account_id uuid not null,
  file_name text not null check (length(file_name) between 1 and 200),
  content_sha256 text not null check (content_sha256 ~ '^[0-9a-f]{64}$'),
  line_count integer not null check (line_count >= 0),
  inserted_count integer not null check (inserted_count >= 0),
  imported_by text not null,
  created_at timestamptz not null default now(),
  foreign key (org_id, bank_account_id) references bank_accounts (org_id, id),
  unique (org_id, content_sha256), unique (org_id, id)
);

-- The matched-payment reference needs this pair; 0050 added such keys only where an
-- existing foreign key demanded one.
alter table payments add constraint payments_org_id_key unique (org_id, id);

create table bank_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete restrict,
  bank_account_id uuid not null,
  import_id uuid not null,
  occurred_on date not null,
  amount_cents bigint not null check (amount_cents <> 0),
  currency char(3) not null,
  description text not null default '',
  reference text,
  counterparty text,
  raw jsonb not null,
  dedupe_key text not null check (dedupe_key ~ '^[0-9a-f]{64}$'),
  state text not null default 'unmatched' check (state in ('unmatched','matched','set_aside')),
  matched_payment_id uuid,
  set_aside_reason text,
  resolved_by text,
  resolved_at timestamptz,
  created_at timestamptz not null default now(),
  foreign key (org_id, bank_account_id) references bank_accounts (org_id, id),
  foreign key (org_id, import_id) references bank_imports (org_id, id),
  foreign key (org_id, matched_payment_id) references payments (org_id, id),
  unique (org_id, bank_account_id, dedupe_key),
  check ((state = 'matched') = (matched_payment_id is not null)),
  check ((state = 'set_aside') = (set_aside_reason is not null)),
  check (state = 'unmatched' or (resolved_by is not null and resolved_at is not null))
);
create index bank_lines_state_idx on bank_lines (org_id, state, occurred_on desc);

-- Source columns are immutable once imported; only the resolution columns may change.
create function protect_bank_line_source() returns trigger language plpgsql
security definer set search_path=pg_catalog,public as $$
begin
  if (to_jsonb(new)-array['state','matched_payment_id','set_aside_reason','resolved_by','resolved_at'])
     is distinct from
     (to_jsonb(old)-array['state','matched_payment_id','set_aside_reason','resolved_by','resolved_at'])
  then raise exception 'bank line source content is immutable'; end if;
  return new;
end $$;
create trigger bank_lines_source_immutable before update on bank_lines
  for each row execute function protect_bank_line_source();
create trigger bank_lines_no_delete before delete on bank_lines
  for each row execute function reject_dispatch_history_mutation();
-- The batch row is immutable except its derived tally, stamped in the same transaction
-- that inserts the lines.
create function protect_bank_import_source() returns trigger language plpgsql
security definer set search_path=pg_catalog,public as $$
begin
  if (to_jsonb(new)-'inserted_count') is distinct from (to_jsonb(old)-'inserted_count')
  then raise exception 'bank import record is immutable'; end if;
  return new;
end $$;
create trigger bank_imports_source_immutable before update on bank_imports
  for each row execute function protect_bank_import_source();
create trigger bank_imports_no_delete before delete on bank_imports
  for each row execute function reject_dispatch_history_mutation();

do $$ declare t text; r text; begin
  foreach t in array array['bank_accounts','bank_imports','bank_lines'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on %I from public', t);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on %I from %I', t, r);
        if r='service_role' then execute format('grant select on %I to service_role', t); end if;
      end if;
    end loop;
  end loop;
end $$;

-- Import a parsed file: find-or-create the account, refuse invalid lines by number,
-- dedupe per line, and stay exact-retry stable (the same file returns its batch).
create function operator_import_bank_lines(p_org_id uuid,p_account_name text,p_currency text,p_file_name text,
  p_content_sha256 text,p_lines jsonb,p_actor_id uuid,p_actor_email text)
returns table(oib_import_id uuid,oib_inserted integer,oib_duplicates integer)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_name text:=trim(coalesce(p_account_name,'')); v_ccy text:=upper(trim(coalesce(p_currency,'')));
  v_account bank_accounts%rowtype; v_import bank_imports%rowtype; v_line jsonb; v_no integer:=0;
  v_date date; v_amount bigint; v_ref text; v_desc text; v_cp text; v_key text;
  v_inserted integer:=0; v_dupes integer:=0; v_id uuid;
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','bank.import');
  if exists(select 1 from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='bank.import'
    and risk='approve_required') then raise exception 'importing bank lines cannot itself require an approval; its grant must not require approval'; end if;
  if v_name='' or length(v_name)>120 then raise exception 'a bank account name is required'; end if;
  if v_ccy !~ '^[A-Z]{3}$' then raise exception 'a bank account currency is required'; end if;
  if p_content_sha256 !~ '^[0-9a-f]{64}$' or length(trim(coalesce(p_file_name,'')))=0 then raise exception 'a file name and content digest are required'; end if;
  if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'the file has no bank lines'; end if;
  if jsonb_array_length(p_lines)>2000 then raise exception 'too many bank lines in one file (max 2000)'; end if;

  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':bank',0));

  select * into v_account from bank_accounts where org_id=p_org_id and name=v_name;
  if found then
    if v_account.currency <> v_ccy then raise exception 'this bank account already exists with a different currency'; end if;
  else
    insert into bank_accounts(org_id,name,currency,created_by) values(p_org_id,v_name,v_ccy,trim(p_actor_email))
      returning * into v_account;
  end if;

  -- An exact retry (same file content) returns the recorded import unchanged.
  select * into v_import from bank_imports where org_id=p_org_id and content_sha256=p_content_sha256;
  if found then
    if v_import.bank_account_id <> v_account.id then raise exception 'this file was already imported into a different bank account'; end if;
    return query select v_import.id,0,v_import.line_count; return;
  end if;

  insert into bank_imports(org_id,bank_account_id,file_name,content_sha256,line_count,inserted_count,imported_by)
    values(p_org_id,v_account.id,trim(p_file_name),p_content_sha256,jsonb_array_length(p_lines),0,trim(p_actor_email))
    returning * into v_import;

  for v_line in select * from jsonb_array_elements(p_lines) loop
    v_no:=v_no+1;
    begin v_date:=(v_line->>'occurred_on')::date; exception when others then v_date:=null; end;
    if v_date is null then raise exception 'bank line %: a valid date is required',v_no; end if;
    if (v_line->>'amount_cents') !~ '^-?[0-9]{1,15}$' then raise exception 'bank line %: a whole signed amount in cents is required',v_no; end if;
    v_amount:=(v_line->>'amount_cents')::bigint;
    if v_amount=0 then raise exception 'bank line %: the amount must not be zero',v_no; end if;
    if upper(coalesce(v_line->>'currency',''))<>v_account.currency then raise exception 'bank line %: currency does not match the account',v_no; end if;
    v_desc:=left(trim(coalesce(v_line->>'description','')),500);
    v_ref:=nullif(left(trim(coalesce(v_line->>'reference','')),140),'');
    v_cp:=nullif(left(trim(coalesce(v_line->>'counterparty','')),200),'');
    v_key:=encode(sha256(convert_to(v_account.id::text||'|'||v_date::text||'|'||v_amount::text||'|'||coalesce(v_ref,'')||'|'||v_desc,'UTF8')),'hex');
    insert into bank_lines(org_id,bank_account_id,import_id,occurred_on,amount_cents,currency,description,reference,counterparty,raw,dedupe_key)
      values(p_org_id,v_account.id,v_import.id,v_date,v_amount,v_account.currency,v_desc,v_ref,v_cp,
        coalesce(v_line->'raw',v_line),v_key)
      on conflict (org_id,bank_account_id,dedupe_key) do nothing
      returning id into v_id;
    if v_id is null then v_dupes:=v_dupes+1; else v_inserted:=v_inserted+1; v_id:=null; end if;
  end loop;

  update bank_imports set inserted_count=v_inserted where id=v_import.id;

  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','bank.import','bank.import','bank_import',v_import.id,'notify','success',
      jsonb_build_object('actor_id',p_actor_id,'actor_email',trim(p_actor_email),'bank_account',v_account.name,
        'file_name',trim(p_file_name),'lines',jsonb_array_length(p_lines),'inserted',v_inserted,'duplicates',v_dupes));
  return query select v_import.id,v_inserted,v_dupes;
end $$;

-- Match a credit line to an invoice: the payment is recorded through operator_record_payment
-- (payments.record authority, outstanding cap, void/paid guards, exactly-once posting) with
-- a line-unique reference, and the line is stamped in the same transaction.
create function operator_match_bank_line(p_org_id uuid,p_line_id uuid,p_invoice_id uuid,p_actor_id uuid,p_actor_email text)
returns table(omb_payment_id uuid,omb_invoice_state invoice_state)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_line bank_lines%rowtype; v_inv invoices%rowtype; r record; v_ref text;
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  select * into v_line from bank_lines where org_id=p_org_id and id=p_line_id for update;
  if not found then raise exception 'bank line not found'; end if;
  if v_line.state='set_aside' then raise exception 'this bank line is set aside; reopen it first'; end if;
  if v_line.state='matched' then
    -- Exact retry returns the recorded fact; a different invoice is refused, never rewired.
    if exists(select 1 from payments where org_id=p_org_id and id=v_line.matched_payment_id and invoice_id=p_invoice_id) then
      return query select v_line.matched_payment_id,(select state from invoices where org_id=p_org_id and id=p_invoice_id);
      return;
    end if;
    raise exception 'bank line already matched';
  end if;
  if v_line.amount_cents<=0 then raise exception 'only a credit bank line can match an invoice'; end if;
  select * into v_inv from invoices where org_id=p_org_id and id=p_invoice_id;
  if not found then raise exception 'invoice not found'; end if;
  if v_inv.currency <> v_line.currency then raise exception 'bank line currency does not match the invoice'; end if;

  v_ref:='bank:'||left(v_line.dedupe_key,32);
  -- The line's day as a UTC instant, independent of the server session timezone.
  select * into r from operator_record_payment(p_org_id,p_invoice_id,v_line.amount_cents,
    (v_line.occurred_on::text||'T00:00:00Z')::timestamptz,v_ref,p_actor_id,p_actor_email);

  update bank_lines set state='matched',matched_payment_id=r.orp_payment_id,
    resolved_by=trim(p_actor_email),resolved_at=clock_timestamp() where id=v_line.id;
  return query select r.orp_payment_id,r.orp_invoice_state;
end $$;

-- Set aside a line the Controller will not consume (an expense, a transfer, Bookkeeper's
-- future work), with a reason; reopen returns it to unmatched. No money moves.
create function operator_set_aside_bank_line(p_org_id uuid,p_line_id uuid,p_reason text,p_actor_id uuid,p_actor_email text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_line bank_lines%rowtype; v_reason text:=trim(coalesce(p_reason,''));
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','bank.review');
  if length(v_reason)<3 or length(v_reason)>500 then raise exception 'a set-aside reason is required'; end if;
  select * into v_line from bank_lines where org_id=p_org_id and id=p_line_id for update;
  if not found then raise exception 'bank line not found'; end if;
  if v_line.state='set_aside' then
    if v_line.set_aside_reason=v_reason then return; end if;
    raise exception 'bank line already set aside';
  end if;
  if v_line.state='matched' then raise exception 'a matched bank line cannot be set aside'; end if;
  update bank_lines set state='set_aside',set_aside_reason=v_reason,
    resolved_by=trim(p_actor_email),resolved_at=clock_timestamp() where id=v_line.id;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','bank.review','bank.review','bank_line',v_line.id,'notify','success',
      jsonb_build_object('actor_id',p_actor_id,'actor_email',trim(p_actor_email),'action','set_aside','reason',v_reason));
end $$;

create function operator_reopen_bank_line(p_org_id uuid,p_line_id uuid,p_actor_id uuid,p_actor_email text)
returns void language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_line bank_lines%rowtype;
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','bank.review');
  select * into v_line from bank_lines where org_id=p_org_id and id=p_line_id for update;
  if not found then raise exception 'bank line not found'; end if;
  if v_line.state='unmatched' then return; end if;
  if v_line.state='matched' then raise exception 'a matched bank line cannot be reopened; its payment exists'; end if;
  update bank_lines set state='unmatched',set_aside_reason=null,resolved_by=null,resolved_at=null where id=v_line.id;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','bank.review','bank.review','bank_line',v_line.id,'notify','success',
      jsonb_build_object('actor_id',p_actor_id,'actor_email',trim(p_actor_email),'action','reopen'));
end $$;

-- The trigger functions get no grant at all: firing does not check EXECUTE (0046).
do $$ declare r text; f regprocedure; v_name text; begin
  for f, v_name in select oid::regprocedure, proname from pg_proc where pronamespace='public'::regnamespace
    and proname in ('operator_import_bank_lines','operator_match_bank_line','operator_set_aside_bank_line','operator_reopen_bank_line',
      'protect_bank_line_source','protect_bank_import_source') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' and v_name like 'operator_%' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
