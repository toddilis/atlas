-- CONFIG-01a console catalogue: the operator entry points for creating and editing this
-- business's products and retailers, so a business can be set up and maintained without
-- SQL and without a Shopify connection. The console verifies the signed-in operator
-- (session, allowlist, same origin); the database enforces the rest: action pause and the
-- business's `catalog.save` / `accounts.save` operator grants (seeded notify-tier at
-- boot, like pricing), field validity, duplicate and stale-edit refusals, that a synced
-- product keeps its source identity, that a retailer's currency is fixed once it has
-- invoices, and an audit row for every change. No role but service_role may call them.

-- Stale-edit detection for products (accounts already carry updated_at).
alter table products add column updated_at timestamptz not null default now();

create function operator_save_product(p_org_id uuid,p_product_id uuid,p_sku text,p_display_name text,p_unit text,
  p_active boolean,p_expected_updated_at timestamptz,p_actor_id uuid,p_actor_email text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_sku text:=trim(coalesce(p_sku,'')); v_name text:=trim(coalesce(p_display_name,''));
  v_unit text:=trim(coalesce(p_unit,'each')); v_row products%rowtype; v_id uuid;
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','catalog.save');
  if v_sku='' or v_name='' or v_unit='' or p_active is null then raise exception 'catalogue fields required'; end if;
  if length(v_sku)>64 or length(v_name)>200 or length(v_unit)>32 then raise exception 'catalogue field too long'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':catalog',0));
  if p_product_id is null then
    select * into v_row from products where org_id=p_org_id and sku=v_sku;
    if found then
      -- An exact retry returns the created product unchanged and is not audited twice.
      if v_row.display_name=v_name and v_row.unit=v_unit and v_row.active=p_active then return v_row.id; end if;
      raise exception 'sku already exists';
    end if;
    insert into products(org_id,sku,display_name,unit,active) values(p_org_id,v_sku,v_name,v_unit,p_active) returning id into v_id;
  else
    select * into v_row from products where org_id=p_org_id and id=p_product_id;
    if not found then raise exception 'product not found'; end if;
    if p_expected_updated_at is null or v_row.updated_at is distinct from p_expected_updated_at then
      raise exception 'product changed since it was loaded'; end if;
    if v_row.sku<>v_sku then
      -- A synced product's sku is its source identity: renaming it would re-create the
      -- product on the next sync and strand this row, so it is refused, never silent.
      if v_row.shopify_product_id is not null or v_row.shopify_variant_id is not null then
        raise exception 'synced product sku is fixed'; end if;
      if exists(select 1 from products where org_id=p_org_id and sku=v_sku) then raise exception 'sku already exists'; end if;
    end if;
    -- clock_timestamp(), not now(): the stale-edit token must move even within one transaction.
    update products set sku=v_sku,display_name=v_name,unit=v_unit,active=p_active,updated_at=clock_timestamp() where id=v_row.id;
    v_id:=v_row.id;
  end if;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','catalog.save','catalog.save','product',v_id,'notify','success',jsonb_build_object(
      'actor_id',p_actor_id,'actor_email',trim(p_actor_email),'sku',v_sku,'display_name',v_name,'unit',v_unit,
      'active',p_active,'created',p_product_id is null));
  return v_id;
end $$;

create function operator_save_account(p_org_id uuid,p_account_id uuid,p_name text,p_currency text,p_tax_exempt boolean,
  p_payment_terms_days integer,p_billing_email text,p_status text,p_expected_updated_at timestamptz,
  p_actor_id uuid,p_actor_email text) returns uuid
language plpgsql security definer set search_path=pg_catalog,public as $$
declare v_name text:=trim(coalesce(p_name,'')); v_currency text:=upper(trim(coalesce(p_currency,'')));
  v_email text:=nullif(trim(coalesce(p_billing_email,'')),''); v_status text:=coalesce(p_status,'active');
  v_row accounts%rowtype; v_id uuid;
begin
  if p_actor_id is null or length(trim(coalesce(p_actor_email,'')))=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','accounts.save');
  if v_name='' or p_tax_exempt is null then raise exception 'retailer fields required'; end if;
  if length(v_name)>200 or length(coalesce(v_email,''))>200 then raise exception 'retailer field too long'; end if;
  if v_currency!~'^[A-Z]{3}$' then raise exception 'retailer currency must be a 3-letter code'; end if;
  if p_payment_terms_days is null or p_payment_terms_days<0 or p_payment_terms_days>365 then
    raise exception 'retailer payment terms days out of range'; end if;
  if v_status not in ('active','dormant','closed') then raise exception 'unknown retailer status'; end if;
  if v_email is not null and v_email!~'^[^@[:space:]]+@[^@[:space:]]+$' then raise exception 'retailer billing email invalid'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text||':catalog',0));
  if p_account_id is null then
    select * into v_row from accounts where org_id=p_org_id and name=v_name;
    if found then
      -- An exact retry returns the created retailer unchanged and is not audited twice.
      if v_row.currency=v_currency and v_row.tax_exempt=p_tax_exempt and v_row.payment_terms_days=p_payment_terms_days
        and v_row.billing_email is not distinct from v_email and v_row.status=v_status then return v_row.id; end if;
      raise exception 'retailer name already exists';
    end if;
    insert into accounts(org_id,name,currency,tax_exempt,payment_terms_days,billing_email,status)
      values(p_org_id,v_name,v_currency,p_tax_exempt,p_payment_terms_days,v_email,v_status) returning id into v_id;
  else
    select * into v_row from accounts where org_id=p_org_id and id=p_account_id;
    if not found then raise exception 'retailer not found'; end if;
    if p_expected_updated_at is null or v_row.updated_at is distinct from p_expected_updated_at then
      raise exception 'retailer changed since it was loaded'; end if;
    if v_row.name<>v_name and exists(select 1 from accounts where org_id=p_org_id and name=v_name) then
      raise exception 'retailer name already exists'; end if;
    -- Issued history is in this currency; a different one needs its own retailer record.
    if v_row.currency<>v_currency and exists(select 1 from invoices where org_id=p_org_id and account_id=v_row.id) then
      raise exception 'retailer currency is fixed once it has invoices'; end if;
    update accounts set name=v_name,currency=v_currency,tax_exempt=p_tax_exempt,payment_terms_days=p_payment_terms_days,
      billing_email=v_email,status=v_status,updated_at=clock_timestamp() where id=v_row.id;
    v_id:=v_row.id;
  end if;
  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','accounts.save','accounts.save','account',v_id,'notify','success',jsonb_build_object(
      'actor_id',p_actor_id,'actor_email',trim(p_actor_email),'name',v_name,'currency',v_currency,'tax_exempt',p_tax_exempt,
      'payment_terms_days',p_payment_terms_days,'status',v_status,'created',p_account_id is null));
  return v_id;
end $$;

do $$ declare r text; f regprocedure; begin
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('operator_save_product','operator_save_account') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
