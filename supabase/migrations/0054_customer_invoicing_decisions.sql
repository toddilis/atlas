-- CONFIG-01d: who Atlas invoices, decided per Shopify customer in the console.
--
-- The owner confirmed on 4 November 2026 how VICE's wholesale reaches Shopify: retailers
-- email their orders and staff enter them as draft orders under the retailer's customer
-- record; an order Shopify shows as paid has been paid ("paid means paid"); and some
-- customers' unpaid orders are never invoiced (a rep's kit). Routing therefore needs a
-- decision per Shopify customer, not only a link someone might forget to make before a
-- shipment arrives:
--   * linked to a retailer: its unpaid orders shipped from the main location are
--     invoiced to that retailer, and an order Shopify shows as paid never is (the
--     Controller's routing, src/agents/controller/routing.ts);
--   * not invoiced: Atlas never invoices this customer's orders; a reason is required;
--   * undecided: an unpaid draft order shipped for it is held (route 'held') until
--     someone decides, instead of being ignored as a retail order.
--
-- operator_decide_shopify_customer records a decision under the operator rules
-- (identity, pause, the customers.decide grant seeded notify-tier at boot like catalogue
-- setup, a retailer of the same business that is not closed, a reason to stop
-- invoicing, stale-edit refusal, an audit row) and in the same transaction releases the
-- customer's held shipments: to wholesale when linked and the synced order is still
-- unpaid, otherwise to ignored with the reason. The worker's invoice part discovery
-- picks released shipments up on its next pass. The sync's customer upsert names its
-- own columns, so a decision survives every sync. search_shopify_customers finds a
-- business's customers by name, email, company or Shopify id. Service-role only.

alter type fulfillment_route add value if not exists 'held';

alter table shopify_customers
  add column do_not_invoice boolean not null default false,
  add column decision_note text
    check (decision_note is null or (decision_note = trim(decision_note) and length(decision_note) between 3 and 500)),
  add column decided_at timestamptz,
  add column decided_by text,
  add constraint shopify_customers_one_decision check (not (do_not_invoice and account_id is not null)),
  add constraint shopify_customers_not_invoiced_reason check (not do_not_invoice or decision_note is not null);
comment on column shopify_customers.do_not_invoice is
  'CONFIG-01d: the business never invoices this customer''s orders (for example a rep''s kit); decision_note says why.';

-- The decision as one comparable value: the retailer id, 'not_invoiced' or 'undecided'.
-- The console carries it as the stale-edit token.
create function shopify_customer_decision(c shopify_customers) returns text
language sql immutable set search_path=pg_catalog,public as $$
  select case when c.account_id is not null then c.account_id::text when c.do_not_invoice then 'not_invoiced' else 'undecided' end
$$;

create function operator_decide_shopify_customer(p_org_id uuid,p_customer_id uuid,p_decision text,p_account_id uuid,
  p_note text,p_expected text,p_actor_id uuid,p_actor_email text)
returns table(odc_released integer,odc_not_invoiced integer,odc_unchanged boolean)
language plpgsql security definer set search_path=pg_catalog,public as $$
declare c shopify_customers%rowtype; a accounts%rowtype; e record; v_current text; v_target text;
  v_note text:=nullif(trim(coalesce(p_note,'')),''); v_who text:=trim(coalesce(p_actor_email,''));
  v_released integer:=0; v_ignored integer:=0;
begin
  if p_actor_id is null or length(v_who)=0 then raise exception 'operator identity required'; end if;
  perform assert_action_authority(p_org_id,'operator','customers.decide');
  if exists(select 1 from tool_grants where org_id=p_org_id and agent_name='operator' and tool_name='customers.decide'
    and enabled and risk='approve_required') then
    raise exception 'deciding a customer cannot itself require an approval; its grant must not require approval'; end if;
  if p_decision is null or p_decision not in ('retailer','not_invoiced','undecided') then
    raise exception 'customer decision required'; end if;
  select * into c from shopify_customers where org_id=p_org_id and id=p_customer_id for update;
  if not found then raise exception 'shopify customer not found'; end if;
  if p_decision='retailer' then
    if p_account_id is null then raise exception 'retailer not found'; end if;
    select * into a from accounts where org_id=p_org_id and id=p_account_id;
    if not found then raise exception 'retailer not found'; end if;
    if a.status='closed' then raise exception 'retailer is closed'; end if;
    v_note:=null; v_target:=p_account_id::text;
  elsif p_decision='not_invoiced' then
    if v_note is null or length(v_note)<3 then raise exception 'a reason is required to stop invoicing a customer'; end if;
    if length(v_note)>500 then raise exception 'reason too long'; end if;
    v_target:='not_invoiced';
  else
    v_note:=null; v_target:='undecided';
  end if;
  v_current:=shopify_customer_decision(c);
  -- A repeat of the decision already stored (a retried submit) changes nothing and is
  -- not audited twice.
  if v_current=v_target and c.decision_note is not distinct from v_note then
    return query select 0,0,true; return;
  end if;
  if p_expected is null or p_expected is distinct from v_current then
    raise exception 'customer decision changed since it was loaded'; end if;

  update shopify_customers set account_id=case when p_decision='retailer' then p_account_id end,
    do_not_invoice=(p_decision='not_invoiced'), decision_note=v_note,
    decided_at=clock_timestamp(), decided_by=v_who
  where org_id=p_org_id and id=c.id;

  -- Release the customer's held shipments with the decision. Undecided keeps them held.
  if p_decision<>'undecided' then
    for e in select fe.id, o.financial_status from fulfillment_events fe
        join shopify_orders o on o.org_id=fe.org_id and o.id=fe.shopify_order_id
        where fe.org_id=p_org_id and fe.route='held' and o.shopify_customer_id=c.shopify_customer_id
        order by fe.occurred_at, fe.id for update of fe loop
      if p_decision='retailer' and e.financial_status='pending' then
        update fulfillment_events set route='wholesale', account_id=p_account_id,
          reason='released to invoicing: customer linked to '||a.name||' by '||v_who
        where org_id=p_org_id and id=e.id;
        v_released:=v_released+1;
      else
        update fulfillment_events set route='ignored', account_id=null,
          reason=case when p_decision='retailer'
            then 'not invoiced: '||coalesce(e.financial_status,'payment status unknown')||' in Shopify when its customer was linked by '||v_who
            else 'not invoiced: customer marked not invoiced by '||v_who||' ('||v_note||')' end
        where org_id=p_org_id and id=e.id;
        v_ignored:=v_ignored+1;
      end if;
    end loop;
  end if;

  insert into audit_log(org_id,agent_name,action,tool_name,subject_type,subject_id,risk,outcome,detail)
    values(p_org_id,'operator','customers.decide','customers.decide','shopify_customer',c.id,'notify','success',jsonb_build_object(
      'actor_id',p_actor_id,'actor_email',v_who,'shopify_customer_id',c.shopify_customer_id,
      'from',v_current,'to',v_target,'note',v_note,'released',v_released,'not_invoiced',v_ignored));
  return query select v_released,v_ignored,false;
end $$;

-- The console's customer search: a business's own customers whose email, name or company
-- contains the text, or whose Shopify id is it. position() rather than LIKE, so the text
-- is matched literally.
create function search_shopify_customers(p_org_id uuid,p_query text,p_limit integer default 50)
returns table(id uuid,shopify_customer_id text,email text,first_name text,last_name text,company text,tags text[],
  account_id uuid,do_not_invoice boolean,decision_note text,decided_at timestamptz,decided_by text)
language sql stable security definer set search_path=pg_catalog,public as $$
  select c.id,c.shopify_customer_id,c.email,c.first_name,c.last_name,nullif(trim(c.default_address->>'company'),''),c.tags,
    c.account_id,c.do_not_invoice,c.decision_note,c.decided_at,c.decided_by
  from shopify_customers c, (select lower(trim(coalesce(p_query,''))) as q) s
  where c.org_id=p_org_id and length(s.q)>=2
    and (position(s.q in lower(coalesce(c.email,'')))>0
      or position(s.q in lower(concat_ws(' ',c.first_name,c.last_name)))>0
      or position(s.q in lower(coalesce(c.default_address->>'company','')))>0
      or c.shopify_customer_id=s.q)
  order by lower(concat_ws(' ',c.first_name,c.last_name)), c.id
  limit least(greatest(coalesce(p_limit,50),1),100)
$$;

do $$ declare r text; f regprocedure; begin
  for f in select oid::regprocedure from pg_proc where pronamespace='public'::regnamespace
    and proname in ('shopify_customer_decision','operator_decide_shopify_customer','search_shopify_customers') loop
    execute format('revoke all on function %s from public',f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists(select 1 from pg_roles where rolname=r) then execute format('revoke all on function %s from %I',f,r);
        if r='service_role' then execute format('grant execute on function %s to service_role',f); end if;
      end if;
    end loop;
  end loop;
end $$;
