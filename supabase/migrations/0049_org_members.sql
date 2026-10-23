-- TENANT-01b: who may operate a business lives in the database, per business. Until now
-- console authority was only the deployment's ATLAS_OPERATOR_EMAILS environment variable
-- — one list for the whole deployment, invisible to the data layer, unusable the moment
-- a second business shares an environment. org_members records each business's own
-- operators; the console enforces it on every request ON TOP of the environment
-- allowlist (membership can narrow access, never widen it — the env list stays the
-- deployment's outer wall). While a business has no member rows the environment list
-- alone admits operators (bootstrap mode); the first row added must be the acting
-- operator's own, and nobody can disable their own membership — together those two
-- rules make a membership lockout unreachable from the console.
--
-- members.save is NEVER seeded at boot: deciding who operates a business is a
-- deliberate business switch, like issuing, payment entry and voiding. An
-- approve_required grant is refused outright.

create table org_members (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id) on delete restrict,
  email text not null check (email = lower(trim(email)) and email ~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length(email) <= 320),
  enabled boolean not null default true,
  added_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (org_id, email)
);
comment on table org_members is 'Per-business console operators (0049). Enforced alongside the deployment allowlist: membership narrows, never widens.';

alter table org_members enable row level security;
revoke all on org_members from public;
do $$ declare r text; begin
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=r) then
      execute format('revoke all on org_members from %I',r);
      if r='service_role' then grant select on org_members to service_role; end if;
    end if;
  end loop;
end $$;

create function operator_save_member(p_org_id uuid,p_member_id uuid,p_email text,p_enabled boolean,
  p_expected_updated_at timestamptz,p_actor_id uuid,p_actor_email text)
returns table(osm_member_id uuid,osm_updated_at timestamptz)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_email text:=lower(trim(coalesce(p_email,''))); v_actor text:=lower(trim(coalesce(p_actor_email,'')));
        v_row org_members%rowtype;
begin
  if p_actor_id is null or length(v_actor)=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','members.save');
  if exists(select 1 from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='members.save'
    and risk='approve_required') then raise exception 'managing members cannot itself require an approval; its grant must not require approval'; end if;
  if p_enabled is null or v_email='' or v_email !~ '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' or length(v_email)>320 then
    raise exception 'a valid member email is required'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':members',0));

  if p_member_id is null then
    select * into v_row from org_members where org_id=p_org_id and email=v_email;
    if found then
      -- An exact retry returns the created member unchanged and is not audited twice.
      if v_row.enabled=p_enabled then return query select v_row.id,v_row.updated_at; return; end if;
      raise exception 'member already exists';
    end if;
    -- The first member must be the acting operator: adding someone else first would cut
    -- off every environment-admitted operator who is not yet a member, yourself included.
    if not exists(select 1 from org_members where org_id=p_org_id) and v_email<>v_actor then
      raise exception 'add your own membership first'; end if;
    insert into org_members(org_id,email,enabled,added_by) values(p_org_id,v_email,p_enabled,v_actor)
      returning * into v_row;
  else
    select * into v_row from org_members where org_id=p_org_id and id=p_member_id;
    if not found then raise exception 'member not found'; end if;
    -- A member's email is their identity: changing it is a remove-and-add, never a rename.
    if v_email<>v_row.email then raise exception 'member email is fixed; add a new member instead'; end if;
    if p_expected_updated_at is null or v_row.updated_at is distinct from p_expected_updated_at then
      raise exception 'member changed since it was loaded'; end if;
    if not p_enabled and v_row.email=v_actor then raise exception 'you cannot disable your own membership'; end if;
    -- clock_timestamp(), not now(): the stale-edit token must move even within one transaction.
    update org_members set enabled=p_enabled,updated_at=clock_timestamp() where id=v_row.id returning * into v_row;
  end if;

  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','members.save','members.save','org_member',v_row.id,'notify','success',
      jsonb_build_object('actor_id',p_actor_id,'actor_email',v_actor,'email',v_email,'enabled',p_enabled,
        'created',p_member_id is null));
  return query select v_row.id,v_row.updated_at;
end $$;

do $$ declare r text; f regprocedure; begin
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('operator_save_member') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
