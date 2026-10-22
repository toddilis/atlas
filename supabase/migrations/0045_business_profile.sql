-- CONFIG-01c: the business profile that printed documents carry. A bank-transfer
-- business needs its legal name, tax number and payment instructions ON the invoice;
-- until now the document named the business only by display name, so a printed invoice
-- was not a complete tax invoice. One row per business, every field optional (a missing
-- value is simply not printed — never invented), the tax number's label configurable so
-- an NZ business prints "GST number" and another business its own term, with no fork.
-- Maintained through an operator entry point on the catalogue pattern: identity, pause,
-- the profile.save grant (seeded notify-tier: setup, not money movement), bounded
-- trimmed fields with empty meaning cleared, stale-edit detection, retry-stable saves,
-- an audit row per change. Service-role only.

create table business_profiles (
  org_id uuid primary key references orgs(id) on delete restrict,
  legal_name text,
  tax_label text not null default 'Tax number',
  tax_number text,
  address text,
  payment_instructions text,
  updated_at timestamptz not null default now()
);
do $$ declare r text; begin
  execute 'alter table business_profiles enable row level security';
  execute 'revoke all on table business_profiles from public';
  foreach r in array array['anon','authenticated','service_role'] loop
    if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on table business_profiles from %I',r);
      if r='service_role' then execute 'grant select on table business_profiles to service_role'; end if;
    end if;
  end loop;
end $$;

create function operator_save_business_profile(p_org_id uuid,p_legal_name text,p_tax_label text,p_tax_number text,
  p_address text,p_payment_instructions text,p_expected_updated_at timestamptz,p_actor_id uuid,p_actor_email text) returns void
language plpgsql security definer set search_path=pg_catalog,public as $$
declare
  v_legal text:=nullif(trim(coalesce(p_legal_name,'')),''); v_label text:=coalesce(nullif(trim(coalesce(p_tax_label,'')),''),'Tax number');
  v_tax text:=nullif(trim(coalesce(p_tax_number,'')),''); v_address text:=nullif(trim(coalesce(p_address,'')),'');
  v_pay text:=nullif(trim(coalesce(p_payment_instructions,'')),''); v_row business_profiles%rowtype;
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','profile.save');
  if length(coalesce(v_legal,''))>200 or length(v_label)>40 or length(coalesce(v_tax,''))>64
    or length(coalesce(v_address,''))>500 or length(coalesce(v_pay,''))>1000 then
    raise exception 'profile field too long'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':profile',0));
  select * into v_row from business_profiles where org_id=p_org_id;
  if found then
    -- An exact retry returns unchanged and is not audited twice.
    if v_row.legal_name is not distinct from v_legal and v_row.tax_label=v_label and v_row.tax_number is not distinct from v_tax
      and v_row.address is not distinct from v_address and v_row.payment_instructions is not distinct from v_pay then return; end if;
    if p_expected_updated_at is null or v_row.updated_at is distinct from p_expected_updated_at then
      raise exception 'profile changed since it was loaded'; end if;
    update business_profiles set legal_name=v_legal,tax_label=v_label,tax_number=v_tax,address=v_address,
      payment_instructions=v_pay,updated_at=clock_timestamp() where org_id=p_org_id;
  else
    insert into business_profiles(org_id,legal_name,tax_label,tax_number,address,payment_instructions)
      values(p_org_id,v_legal,v_label,v_tax,v_address,v_pay);
  end if;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','profile.save','profile.save','business_profile',p_org_id,'notify','success',jsonb_build_object(
      'actor_id',p_actor_id,'actor_email',trim(p_actor_email),'legal_name',v_legal,'tax_label',v_label,
      'tax_number',v_tax,'has_address',v_address is not null,'has_payment_instructions',v_pay is not null));
end $$;

do $$ declare r text; f regprocedure; begin
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('operator_save_business_profile') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
