-- STMT-01 (CLOSE-01 slice): an operator generates a retailer statement in the console.
-- The derivation stays owned by generate_statement_atomic (0015/0020): opening, charges,
-- payments, closing and aging in the given timezone, persisted immutably. This entry
-- point adds the operator rules: identity, action pause, the statements.generate grant
-- (seeded notify-tier at boot — a statement is a read-projection snapshot, the same
-- class as pricing edits), an as-of bound (not in the future, with UTC+14 calendar skew
-- for date-only entry), a validated timezone, exact-retry stability (the same account,
-- period and as-of returns the already-generated statement instead of a duplicate row —
-- a deliberate redraft uses a new as-of, which 0015 intentionally allows), and an audit
-- row per generated statement. Service-role only.

create function operator_generate_statement(p_org_id uuid,p_account_id uuid,p_period_start_at timestamptz,
  p_as_of_at timestamptz,p_timezone text,p_actor_id uuid,p_actor_email text)
returns table(ogs_statement_id uuid,ogs_closing_balance_cents bigint,ogs_line_count integer)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_tz text:=coalesce(nullif(trim(p_timezone),''),'Pacific/Auckland'); v_existing statements%rowtype; r record;
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','statements.generate');
  if p_as_of_at is null or p_as_of_at>clock_timestamp()+interval '14 hours' then
    raise exception 'statement as-of must not be in the future'; end if;
  begin
    perform now() at time zone v_tz;
  exception when others then
    raise exception 'unknown statement timezone';
  end;

  select * into v_existing from statements where org_id=p_org_id and account_id=p_account_id
    and period_start_at=p_period_start_at and as_of_at=p_as_of_at
    order by generated_at desc limit 1;
  if found then
    return query select v_existing.id,v_existing.closing_balance_cents,
      (select count(*)::integer from statement_lines where statement_id=v_existing.id);
    return;
  end if;

  select * into r from generate_statement_atomic(p_org_id,p_account_id,p_period_start_at,p_as_of_at,
    trim(p_actor_email),v_tz);

  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','statements.generate','statements.generate','statement',r.statement_id,'notify','success',
      jsonb_build_object('actor_id',p_actor_id,'actor_email',trim(p_actor_email),'account_id',p_account_id,
        'period_start_at',p_period_start_at,'as_of_at',p_as_of_at,'timezone',v_tz,
        'closing_balance_cents',r.closing_balance_cents::text,'line_count',r.line_count));
  return query select r.statement_id,r.closing_balance_cents,r.line_count;
end $$;

do $$ declare r text; f regprocedure; begin
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('operator_generate_statement') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
