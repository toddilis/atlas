-- FLOW-01B-a: the shared bank source (PLAN D18). A business's bank accounts and the
-- statement lines imported for them, kept as append-only evidence: every line, not only
-- customer receipts, so the Controller can match receipts to invoices (FLOW-01B-b) and
-- the Bookkeeper module can later match or code the rest from the same rows.
--
-- An account's bank, reference and currency are its identity — one account per currency
-- balance, so a multi-currency Wise account is one row per currency. A line is stored
-- once per account: by the bank's own transaction id when the file carries one, else by
-- its content, numbered among identical lines in the same file, so re-importing a file
-- or an overlapping export never stores a line twice. The same transaction id saying
-- something different refuses the whole file: evidence is never overwritten. Each
-- import is recorded with the file's SHA-256 (an exact retry adopts the stored import),
-- its counts and the operator, and audited.
--
-- The only file layout until the Wise/ASB sample arrives is atlas_csv_v1, parsed by the
-- console; the bank layouts become further import formats against the real sample
-- (FLOW-01B-c), never guessed. Both grants are seeded notify-tier at boot: setting up
-- an account and importing evidence move no money and change no invoice. Service-role
-- only, like every operator entry point.

create table bank_accounts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete restrict,
  display_name text not null check (display_name = trim(display_name) and length(display_name) between 1 and 100),
  bank_name text not null check (bank_name = trim(bank_name) and length(bank_name) between 1 and 60),
  account_ref text not null check (account_ref = trim(account_ref) and length(account_ref) between 2 and 40),
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  import_format text not null default 'atlas_csv_v1' check (import_format in ('atlas_csv_v1')),
  enabled boolean not null default true,
  added_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, id)
);
create unique index bank_accounts_identity on bank_accounts(org_id, lower(bank_name), lower(account_ref), currency);
comment on table bank_accounts is
  'A business''s bank accounts, one per currency balance (0051). Bank, reference and currency are fixed: every stored line hangs off them.';

create table bank_import_batches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete restrict,
  bank_account_id uuid not null,
  file_name text not null check (length(file_name) between 1 and 255),
  file_sha256 text not null check (file_sha256 ~ '^[0-9a-f]{64}$'),
  import_format text not null,
  line_count integer not null check (line_count between 1 and 5000),
  new_count integer not null check (new_count >= 0),
  existing_count integer not null check (existing_count >= 0),
  first_posted_on date not null,
  last_posted_on date not null,
  imported_by text not null,
  actor_id uuid not null,
  created_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, bank_account_id, file_sha256),
  foreign key (org_id, bank_account_id) references bank_accounts(org_id, id) on delete restrict,
  check (new_count + existing_count = line_count),
  check (first_posted_on <= last_posted_on)
);
comment on table bank_import_batches is
  'One row per imported statement file (0051): who, when, which file (SHA-256) and what it added. Append-only.';

create table bank_transactions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete restrict,
  bank_account_id uuid not null,
  import_batch_id uuid not null,
  line_key text not null check (length(line_key) between 4 and 200),
  posted_on date not null,
  amount_cents bigint not null,
  currency char(3) not null check (currency ~ '^[A-Z]{3}$'),
  description text not null check (length(description) between 1 and 500),
  reference text check (reference is null or length(reference) between 1 and 200),
  counterparty text check (counterparty is null or length(counterparty) between 1 and 200),
  provider_txn_id text check (provider_txn_id is null or length(provider_txn_id) between 1 and 100),
  source_row integer not null check (source_row > 1),
  raw jsonb not null check (jsonb_typeof(raw) = 'object'),
  created_at timestamptz not null default now(),
  unique (org_id, id),
  unique (org_id, bank_account_id, line_key),
  foreign key (org_id, bank_account_id) references bank_accounts(org_id, id) on delete restrict,
  foreign key (org_id, import_batch_id) references bank_import_batches(org_id, id) on delete restrict
);
create index bank_transactions_account_date on bank_transactions(org_id, bank_account_id, posted_on desc);
comment on table bank_transactions is
  'Every bank statement line, stored once per account (0051). Amounts are signed: credits positive, debits negative. '
  'raw keeps the parsed source row. Append-only evidence; matching state lives elsewhere (FLOW-01B-b).';
comment on column bank_transactions.line_key is
  'The line''s identity on its account: id:<bank transaction id>, or content:<sha256 of date, amount, description, '
  'reference, counterparty>#<order among identical lines in the importing file>.';

create function bank_evidence_append_only() returns trigger language plpgsql as $$
begin raise exception '% rows are append-only evidence', tg_table_name; end $$;
create trigger bank_import_batches_append_only before update or delete on bank_import_batches
  for each row execute function bank_evidence_append_only();
create trigger bank_transactions_append_only before update or delete on bank_transactions
  for each row execute function bank_evidence_append_only();

do $$ declare t text; r text; begin
  foreach t in array array['bank_accounts','bank_import_batches','bank_transactions'] loop
    execute format('alter table %I enable row level security',t);
    execute format('revoke all on %I from public',t);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then
        execute format('revoke all on %I from %I',t,r);
        if r='service_role' then execute format('grant select on %I to service_role',t); end if;
      end if;
    end loop;
  end loop;
end $$;

-- A strict calendar date, or null: the regex gates every cast, so nothing here raises.
create function bank_line_date(p text) returns date language sql immutable set search_path=pg_catalog as $$
  select case
    when p is null or p !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then null
    when substr(p,6,2)::int not between 1 and 12 or substr(p,1,4)::int < 1 then null
    when substr(p,9,2)::int not between 1 and
      extract(day from make_date(substr(p,1,4)::int,substr(p,6,2)::int,1) + interval '1 month' - interval '1 day')::int then null
    else p::date end
$$;

-- The parsed lines with their identity on the account. Callers validate the shape first.
create function bank_import_keyed(p_lines jsonb)
returns table(source_row integer,posted_on date,amount_cents bigint,currency text,description text,reference text,
  counterparty text,provider_txn_id text,raw jsonb,line_key text)
language sql stable set search_path=pg_catalog,public as $$
  with input as (
    select (e.value->>'row')::int as source_row, bank_line_date(e.value->>'posted_on') as posted_on,
      (e.value->>'amount_cents')::bigint as amount_cents, nullif(trim(coalesce(e.value->>'currency','')),'') as currency,
      trim(e.value->>'description') as description,
      nullif(trim(coalesce(e.value->>'reference','')),'') as reference,
      nullif(trim(coalesce(e.value->>'counterparty','')),'') as counterparty,
      nullif(trim(coalesce(e.value->>'transaction_id','')),'') as provider_txn_id,
      coalesce(e.value->'raw','{}'::jsonb) as raw, e.ord
    from jsonb_array_elements(p_lines) with ordinality e(value,ord)
  )
  select source_row,posted_on,amount_cents,currency,description,reference,counterparty,provider_txn_id,raw,
    case when provider_txn_id is not null then 'id:'||provider_txn_id
      else 'content:'||encode(sha256(convert_to(jsonb_build_array(posted_on::text,amount_cents::text,description,reference,counterparty)::text,'UTF8')),'hex')
        ||'#'||row_number() over (partition by provider_txn_id is null,posted_on,amount_cents,description,reference,counterparty order by ord)
    end
  from input
$$;

create function operator_save_bank_account(p_org_id uuid,p_account_id uuid,p_display_name text,p_bank_name text,
  p_account_ref text,p_currency text,p_enabled boolean,p_expected_updated_at timestamptz,p_actor_id uuid,p_actor_email text)
returns uuid language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_row bank_accounts%rowtype; v_id uuid; v_risk text;
  v_name text:=trim(coalesce(p_display_name,'')); v_bank text:=trim(coalesce(p_bank_name,''));
  v_ref text:=trim(coalesce(p_account_ref,'')); v_currency text:=upper(trim(coalesce(p_currency,'')));
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','bank_accounts.save');
  select risk into v_risk from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='bank_accounts.save' and enabled;
  if v_risk='approve_required' then raise exception 'saving a bank account cannot itself require an approval; its grant must not require approval'; end if;
  if p_enabled is null then raise exception 'bank account fields required'; end if;
  if length(v_name)<1 or length(v_name)>100 then raise exception 'bank account name required'; end if;
  -- One account save per business at a time, so the identity check cannot race a create.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':bank-accounts',0));
  if p_account_id is null then
    if length(v_bank)<1 or length(v_bank)>60 then raise exception 'bank name required'; end if;
    if length(v_ref)<2 or length(v_ref)>40 then raise exception 'bank account reference required'; end if;
    if v_currency !~ '^[A-Z]{3}$' then raise exception 'bank account currency must be a three-letter code'; end if;
    select * into v_row from bank_accounts
      where org_id=p_org_id and lower(bank_name)=lower(v_bank) and lower(account_ref)=lower(v_ref) and currency=v_currency;
    if found then
      -- An exact retry returns the stored account and is not audited twice.
      if v_row.display_name=v_name and v_row.enabled=p_enabled then return v_row.id; end if;
      raise exception 'this bank account already exists for this business';
    end if;
    insert into bank_accounts(org_id,display_name,bank_name,account_ref,currency,enabled,added_by)
      values(p_org_id,v_name,v_bank,v_ref,v_currency,p_enabled,trim(p_actor_email)) returning id into v_id;
    select * into v_row from bank_accounts where id=v_id;
  else
    select * into v_row from bank_accounts where org_id=p_org_id and id=p_account_id for update;
    if not found then raise exception 'bank account not found'; end if;
    if p_expected_updated_at is null or v_row.updated_at is distinct from p_expected_updated_at then
      raise exception 'bank account changed since it was loaded'; end if;
    -- The identity every stored line hangs off never changes: a different account is a new account.
    if (v_bank<>'' and lower(v_bank)<>lower(v_row.bank_name)) or (v_ref<>'' and lower(v_ref)<>lower(v_row.account_ref))
       or (v_currency<>'' and v_currency<>v_row.currency) then
      raise exception 'a bank account''s bank, reference and currency are fixed'; end if;
    update bank_accounts set display_name=v_name,enabled=p_enabled,updated_at=clock_timestamp() where id=v_row.id;
    v_id:=v_row.id;
  end if;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','bank_accounts.save','bank_accounts.save','bank_account',v_id,'notify','success',jsonb_build_object(
      'actor_id',p_actor_id,'actor_email',trim(p_actor_email),'display_name',v_name,'bank_name',v_row.bank_name,
      'account_ref',v_row.account_ref,'currency',v_row.currency,'enabled',p_enabled,'created',p_account_id is null));
  return v_id;
end $$;

create function operator_import_bank_lines(p_org_id uuid,p_bank_account_id uuid,p_file_name text,p_file_sha256 text,
  p_lines jsonb,p_actor_id uuid,p_actor_email text)
returns table(oib_batch_id uuid,oib_line_count integer,oib_new_count integer,oib_existing_count integer,oib_was_existing boolean)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_account bank_accounts%rowtype; v_batch bank_import_batches%rowtype; v_risk text; v_row int;
  v_name text:=trim(coalesce(p_file_name,'')); v_count int; v_new int; v_first date; v_last date; v_inserted int;
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','bank.import');
  select risk into v_risk from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='bank.import' and enabled;
  if v_risk='approve_required' then raise exception 'importing a bank statement cannot itself require an approval; its grant must not require approval'; end if;
  if length(v_name)<1 or length(v_name)>255 then raise exception 'bank file name required'; end if;
  if p_file_sha256 is null or p_file_sha256 !~ '^[0-9a-f]{64}$' then raise exception 'bank file digest required'; end if;
  if p_lines is null or jsonb_typeof(p_lines)<>'array' then raise exception 'bank lines required'; end if;
  v_count:=jsonb_array_length(p_lines);
  if v_count<1 then raise exception 'bank file has no lines'; end if;
  if v_count>5000 then raise exception 'bank file has too many lines'; end if;

  select * into v_account from bank_accounts where org_id=p_org_id and id=p_bank_account_id;
  if not found then raise exception 'bank account not found'; end if;
  if not v_account.enabled then raise exception 'bank account is disabled'; end if;

  -- One import per account at a time: the duplicate checks and the insert cannot race.
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':bank:'||p_bank_account_id::text,0));

  -- The same file for the same account is a retry: it adopts the stored import.
  select * into v_batch from bank_import_batches
    where org_id=p_org_id and bank_account_id=p_bank_account_id and file_sha256=p_file_sha256;
  if found then
    return query select v_batch.id,v_batch.line_count,v_batch.new_count,v_batch.existing_count,true; return;
  end if;

  -- The whole file is checked before anything is written; the first bad row refuses it.
  select case when e.value->>'row' ~ '^[0-9]{1,7}$' then (e.value->>'row')::int else e.ord::int + 1 end into v_row
    from jsonb_array_elements(p_lines) with ordinality e(value,ord)
    where jsonb_typeof(e.value)<>'object'
       or coalesce(e.value->>'row','') !~ '^([2-9]|[1-9][0-9]{1,6})$'
       or bank_line_date(e.value->>'posted_on') is null
       or bank_line_date(e.value->>'posted_on') not between date '2000-01-01' and (clock_timestamp() at time zone 'UTC')::date + 1
       or coalesce(e.value->>'amount_cents','') !~ '^-?[0-9]{1,15}$'
       or length(trim(coalesce(e.value->>'description','')))<1 or length(e.value->>'description')>500
       or length(coalesce(e.value->>'reference',''))>200 or length(coalesce(e.value->>'counterparty',''))>200
       or length(coalesce(e.value->>'transaction_id',''))>100
       or (e.value ? 'raw' and (jsonb_typeof(e.value->'raw')<>'object' or length((e.value->'raw')::text)>8000))
    order by e.ord limit 1;
  if found then raise exception 'bank row % is invalid', v_row; end if;

  select k.source_row into v_row from bank_import_keyed(p_lines) k
    where k.currency is not null and upper(k.currency)<>v_account.currency::text order by k.source_row limit 1;
  if found then raise exception 'bank row % is in a different currency from its account', v_row; end if;

  select min(k.source_row) into v_row from bank_import_keyed(p_lines) k
    where k.provider_txn_id is not null group by k.provider_txn_id having count(*)>1 order by 1 limit 1;
  if found then raise exception 'bank row % repeats a transaction id within the file', v_row; end if;

  -- An account's lines are identified one way. Mixing rows with and without the bank's
  -- transaction id could store one real line twice, under two identities.
  if exists(select 1 from bank_import_keyed(p_lines) k where k.provider_txn_id is null)
     and exists(select 1 from bank_import_keyed(p_lines) k where k.provider_txn_id is not null) then
    raise exception 'bank file mixes rows with and without a transaction id'; end if;
  if exists(select 1 from bank_transactions t where t.org_id=p_org_id and t.bank_account_id=p_bank_account_id
      and (t.provider_txn_id is null) <> (select bool_and(k.provider_txn_id is null) from bank_import_keyed(p_lines) k)) then
    raise exception 'bank file identifies lines differently from earlier imports for this account'; end if;

  -- A stored line under the same transaction id must say the same thing.
  select k.source_row into v_row from bank_import_keyed(p_lines) k
    join bank_transactions t on t.org_id=p_org_id and t.bank_account_id=p_bank_account_id and t.line_key=k.line_key
    where (t.posted_on,t.amount_cents,t.description,t.reference,t.counterparty)
      is distinct from (k.posted_on,k.amount_cents,k.description,k.reference,k.counterparty)
    order by k.source_row limit 1;
  if found then raise exception 'bank row % conflicts with a stored line', v_row; end if;

  select count(*) filter (where t.id is null), min(k.posted_on), max(k.posted_on) into v_new, v_first, v_last
    from bank_import_keyed(p_lines) k
    left join bank_transactions t on t.org_id=p_org_id and t.bank_account_id=p_bank_account_id and t.line_key=k.line_key;

  insert into bank_import_batches(org_id,bank_account_id,file_name,file_sha256,import_format,line_count,new_count,
      existing_count,first_posted_on,last_posted_on,imported_by,actor_id)
    values(p_org_id,p_bank_account_id,v_name,p_file_sha256,v_account.import_format,v_count,v_new,v_count-v_new,
      v_first,v_last,trim(p_actor_email),p_actor_id)
    returning * into v_batch;

  insert into bank_transactions(org_id,bank_account_id,import_batch_id,line_key,posted_on,amount_cents,currency,
      description,reference,counterparty,provider_txn_id,source_row,raw)
    select p_org_id,p_bank_account_id,v_batch.id,k.line_key,k.posted_on,k.amount_cents,v_account.currency,
      k.description,k.reference,k.counterparty,k.provider_txn_id,k.source_row,k.raw
    from bank_import_keyed(p_lines) k
    on conflict (org_id,bank_account_id,line_key) do nothing;
  get diagnostics v_inserted = row_count;
  if v_inserted<>v_new then raise exception 'bank import counted % new lines but stored %', v_new, v_inserted; end if;

  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','bank.import','bank.import','bank_import_batch',v_batch.id,'notify','success',jsonb_build_object(
      'actor_id',p_actor_id,'actor_email',trim(p_actor_email),'bank_account_id',p_bank_account_id,'file_name',v_name,
      'file_sha256',p_file_sha256,'line_count',v_count,'new_count',v_new,'existing_count',v_count-v_new,
      'first_posted_on',v_first,'last_posted_on',v_last));
  return query select v_batch.id,v_count,v_new,v_count-v_new,false;
end $$;

-- The two entry points are service-only; the helpers are reachable only through them
-- (and the trigger fires without EXECUTE), whatever the platform's default privileges.
do $$ declare r text; f regprocedure; v_entry boolean; begin
  for f, v_entry in select oid::regprocedure, proname in ('operator_save_bank_account','operator_import_bank_lines')
    from pg_proc where pronamespace='public'::regnamespace
    and proname in ('operator_save_bank_account','operator_import_bank_lines','bank_line_date','bank_import_keyed','bank_evidence_append_only') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' and v_entry then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
