-- DATA-01: provider-neutral dispatch quantities, revision history and reserved invoice parts.
-- These are service-only contracts. BILL-01 must claim AND create its invoice in one SQL
-- transaction; no tool or public API exposes standalone claims. No invoice is issued here.

create table dispatch_sources (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references orgs(id),
  provider text not null check (length(provider) > 0),
  connection_key text not null check (length(connection_key) > 0),
  enabled boolean not null default true,
  unique (org_id, id),
  unique (org_id, provider, connection_key)
);
-- The old Shopify canonical tables support one shop per org. Reject rebinding instead
-- of treating their org-only keys as safe for multiple connections (TENANT-01 remains open).
create unique index dispatch_sources_shopify_org on dispatch_sources(org_id) where provider = 'shopify';

create table dispatches (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  source_id uuid not null,
  source_dispatch_key text not null check (length(source_dispatch_key) > 0),
  order_key text not null check (length(order_key) > 0),
  source_revision timestamptz not null,
  source_occurred_at timestamptz,
  source_status text not null,
  location_key text,
  state text not null check (state in ('eligible', 'ineligible', 'blocked', 'correction_required')),
  reason text,
  snapshot jsonb not null,
  updated_at timestamptz not null default now(),
  foreign key (org_id, source_id) references dispatch_sources(org_id, id),
  unique (org_id, source_id, source_dispatch_key),
  unique (org_id, source_id, id),
  unique (org_id, id)
);

create table dispatch_revisions (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  source_id uuid not null,
  dispatch_id uuid not null,
  source_revision timestamptz not null,
  snapshot jsonb not null,
  evidence jsonb not null,
  fingerprint text not null,
  received_at timestamptz not null default now(),
  foreign key (org_id, source_id, dispatch_id) references dispatches(org_id, source_id, id),
  unique (dispatch_id, source_revision, fingerprint)
);

create table dispatch_lines (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  source_id uuid not null,
  dispatch_id uuid not null,
  source_line_key text not null check (length(source_line_key) > 0),
  order_line_key text not null check (length(order_line_key) > 0),
  item_key text,
  quantity integer not null check (quantity > 0),
  ordered_quantity integer not null check (ordered_quantity >= quantity),
  active boolean not null default true,
  foreign key (org_id, source_id, dispatch_id) references dispatches(org_id, source_id, id),
  unique (dispatch_id, source_line_key),
  unique (dispatch_id, order_line_key),
  unique (org_id, source_id, dispatch_id, id)
);

create table dispatch_invoice_parts (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  source_id uuid not null,
  dispatch_id uuid not null,
  claim_key text not null check (length(claim_key) > 0),
  source_revision timestamptz not null,
  created_at timestamptz not null default now(),
  foreign key (org_id, source_id, dispatch_id) references dispatches(org_id, source_id, id),
  unique (dispatch_id),
  unique (org_id, source_id, claim_key),
  unique (org_id, source_id, dispatch_id, id)
);

create table dispatch_allocations (
  org_id uuid not null,
  source_id uuid not null,
  dispatch_id uuid not null,
  part_id uuid not null,
  line_id uuid primary key,
  quantity integer not null check (quantity > 0),
  foreign key (org_id, source_id, dispatch_id, part_id)
    references dispatch_invoice_parts(org_id, source_id, dispatch_id, id),
  foreign key (org_id, source_id, dispatch_id, line_id)
    references dispatch_lines(org_id, source_id, dispatch_id, id)
);

create table dispatch_corrections (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null,
  source_id uuid not null,
  dispatch_id uuid not null,
  revision_id uuid not null references dispatch_revisions(id),
  reason text not null,
  created_at timestamptz not null default now(),
  foreign key (org_id, source_id, dispatch_id) references dispatches(org_id, source_id, id),
  unique (dispatch_id, revision_id, reason)
);

create function reject_dispatch_history_mutation() returns trigger
language plpgsql set search_path = pg_catalog, public as $$
begin raise exception 'dispatch history is append-only'; end $$;

create trigger dispatch_revisions_immutable before update or delete on dispatch_revisions
  for each row execute function reject_dispatch_history_mutation();
create trigger dispatch_parts_immutable before update or delete on dispatch_invoice_parts
  for each row execute function reject_dispatch_history_mutation();
create trigger dispatch_allocations_immutable before update or delete on dispatch_allocations
  for each row execute function reject_dispatch_history_mutation();
create trigger dispatch_corrections_immutable before update or delete on dispatch_corrections
  for each row execute function reject_dispatch_history_mutation();

-- Caller is a trusted adapter, not a browser-selected business ID. The connection is
-- established separately by server configuration and cannot be changed by a payload.
create function project_dispatch(
  p_org_id uuid, p_source_id uuid, p_source_dispatch_key text, p_order_key text,
  p_revision timestamptz, p_status text, p_location_key text, p_lines jsonb,
  p_block_reason text, p_evidence jsonb, p_occurred_at timestamptz default null
) returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_dispatch dispatches%rowtype;
  v_snapshot jsonb;
  v_lines jsonb;
  v_line jsonb;
  v_revision_id uuid;
  v_reason text := p_block_reason;
  v_state text;
  v_claimed boolean;
begin
  if not exists (select 1 from dispatch_sources where org_id = p_org_id and id = p_source_id and enabled) then
    raise exception 'dispatch source is not available to this business';
  end if;
  if p_revision is null or not isfinite(p_revision) or nullif(p_source_dispatch_key, '') is null
    or nullif(p_order_key, '') is null or p_evidence is null
    or (p_occurred_at is not null and not isfinite(p_occurred_at)) then
    raise exception 'dispatch identity, evidence and finite source revision are required';
  end if;
  if p_lines is null or jsonb_typeof(p_lines) <> 'array' then
    raise exception 'dispatch lines must be an array';
  end if;
  -- The order lock is shared with claims: two dispatches cannot race past the order bound.
  perform pg_advisory_xact_lock(hashtextextended(p_source_id::text || ':' || p_order_key, 0));
  perform pg_advisory_xact_lock(hashtextextended(p_source_id::text || ':dispatch:' || p_source_dispatch_key, 0));
  select * into v_dispatch from dispatches where org_id = p_org_id and source_id = p_source_id
    and source_dispatch_key = p_source_dispatch_key for update;
  if found and v_dispatch.order_key <> p_order_key then
    raise exception 'dispatch cannot move to a different order';
  end if;

  -- Validate even trusted adapters. Missing/invalid source data belongs in evidence and
  -- p_block_reason with an empty line array; it must never become a partial billable set.
  for v_line in select value from jsonb_array_elements(p_lines) loop
    if jsonb_typeof(v_line) <> 'object' or nullif(v_line->>'source_line_key', '') is null
      or nullif(v_line->>'order_line_key', '') is null
      or jsonb_typeof(v_line->'quantity') is distinct from 'number'
      or jsonb_typeof(v_line->'ordered_quantity') is distinct from 'number'
      or (v_line->>'quantity') !~ '^[1-9][0-9]{0,8}$'
      or (v_line->>'ordered_quantity') !~ '^[1-9][0-9]{0,8}$'
      or (v_line->>'quantity')::bigint > (v_line->>'ordered_quantity')::bigint then
      raise exception 'invalid normalized dispatch line';
    end if;
    if nullif(btrim(v_line->>'item_key'), '') is null then v_reason := 'missing_item_mapping'; end if;
  end loop;
  if (select count(*) <> count(distinct value->>'source_line_key')
      or count(*) <> count(distinct value->>'order_line_key') from jsonb_array_elements(p_lines)) then
    raise exception 'duplicate normalized dispatch line identity';
  end if;
  select coalesce(jsonb_agg(value order by value->>'source_line_key'), '[]'::jsonb)
    into v_lines from jsonb_array_elements(p_lines);
  if jsonb_array_length(v_lines) = 0 then v_reason := coalesce(v_reason, 'missing_lines'); end if;
  if p_status is null or p_status not in ('succeeded', 'pending', 'cancelled', 'failed') then
    v_reason := coalesce(v_reason, 'unsupported_status');
  end if;
  v_state := case when v_reason is not null then 'blocked'
                  when p_status = 'succeeded' then 'eligible' else 'ineligible' end;
  v_snapshot := jsonb_build_object('order_key', p_order_key, 'status', p_status,
    'location_key', p_location_key, 'occurred_at', p_occurred_at, 'lines', v_lines, 'reason', v_reason);
  if v_dispatch.id is null then
    insert into dispatches(org_id, source_id, source_dispatch_key, order_key, source_revision,
      source_occurred_at, source_status, location_key, state, reason, snapshot)
    values (p_org_id, p_source_id, p_source_dispatch_key, p_order_key, p_revision,
      p_occurred_at, coalesce(p_status, 'unknown'), p_location_key, v_state, v_reason, v_snapshot)
    returning * into v_dispatch;
  end if;
  insert into dispatch_revisions(org_id, source_id, dispatch_id, source_revision, snapshot, evidence, fingerprint)
    values (p_org_id, p_source_id, v_dispatch.id, p_revision, v_snapshot, p_evidence,
      md5(v_snapshot::text || p_evidence::text))
    on conflict (dispatch_id, source_revision, fingerprint) do nothing returning id into v_revision_id;
  if v_revision_id is null then
    select id into v_revision_id from dispatch_revisions where dispatch_id = v_dispatch.id
      and source_revision = p_revision and fingerprint = md5(v_snapshot::text || p_evidence::text);
  end if;
  if p_revision < v_dispatch.source_revision then return v_dispatch.id; end if;
  select exists (select 1 from dispatch_invoice_parts where dispatch_id = v_dispatch.id) into v_claimed;
  if (p_revision = v_dispatch.source_revision and v_snapshot <> v_dispatch.snapshot)
    or (v_claimed and v_snapshot <> v_dispatch.snapshot) then
    v_reason := case when v_claimed then 'changed_after_allocation' else 'conflicting_source_revision' end;
    insert into dispatch_corrections(org_id, source_id, dispatch_id, revision_id, reason)
      values (p_org_id, p_source_id, v_dispatch.id, v_revision_id, v_reason) on conflict do nothing;
    update dispatches set state = case when v_claimed then 'correction_required' else 'blocked' end,
      reason = v_reason, source_revision = greatest(source_revision, p_revision), updated_at = now()
      where id = v_dispatch.id;
    return v_dispatch.id;
  end if;
  -- A correction remains unresolved until an explicit future correction workflow acts.
  if v_dispatch.state = 'correction_required'
    or (v_dispatch.reason = 'conflicting_source_revision' and p_revision = v_dispatch.source_revision) then
    return v_dispatch.id;
  end if;
  update dispatches set source_revision = p_revision, source_status = coalesce(p_status, 'unknown'),
    source_occurred_at = p_occurred_at,
    location_key = p_location_key, state = v_state, reason = v_reason, snapshot = v_snapshot,
    updated_at = now() where id = v_dispatch.id;
  if not v_claimed then
    update dispatch_lines set active = false where dispatch_id = v_dispatch.id;
    insert into dispatch_lines(org_id, source_id, dispatch_id, source_line_key, order_line_key,
      item_key, quantity, ordered_quantity)
    select p_org_id, p_source_id, v_dispatch.id, value->>'source_line_key', value->>'order_line_key',
      value->>'item_key', (value->>'quantity')::int, (value->>'ordered_quantity')::int
      from jsonb_array_elements(v_lines)
    on conflict (dispatch_id, source_line_key) do update set
      order_line_key = excluded.order_line_key, item_key = excluded.item_key,
      quantity = excluded.quantity, ordered_quantity = excluded.ordered_quantity, active = true;
  end if;
  return v_dispatch.id;
end $$;

create function claim_dispatch(
  p_org_id uuid, p_source_id uuid, p_dispatch_id uuid, p_revision timestamptz, p_claim_key text
) returns uuid language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_dispatch dispatches%rowtype; v_part dispatch_invoice_parts%rowtype; v_line dispatch_lines%rowtype; v_used bigint;
begin
  select * into v_dispatch from dispatches where org_id = p_org_id and source_id = p_source_id and id = p_dispatch_id;
  if not found then raise exception 'dispatch is not available to this business/source'; end if;
  perform pg_advisory_xact_lock(hashtextextended(p_source_id::text || ':' || v_dispatch.order_key, 0));
  select * into v_dispatch from dispatches where id = p_dispatch_id for update;
  if not exists (select 1 from dispatch_sources where org_id = p_org_id and id = p_source_id and enabled) then
    raise exception 'dispatch source is disabled';
  end if;
  if v_dispatch.state <> 'eligible' or v_dispatch.source_revision is distinct from p_revision then
    raise exception 'dispatch is not eligible at the expected revision';
  end if;
  if nullif(p_claim_key, '') is null then raise exception 'claim key is required'; end if;
  select * into v_part from dispatch_invoice_parts where dispatch_id = p_dispatch_id;
  if found then
    if v_part.claim_key <> p_claim_key then raise exception 'dispatch is already allocated'; end if;
    return v_part.id;
  end if;
  if not exists (select 1 from dispatch_lines where dispatch_id = p_dispatch_id and active) then
    raise exception 'dispatch has no allocatable lines';
  end if;
  for v_line in select * from dispatch_lines where dispatch_id = p_dispatch_id and active loop
    select coalesce(sum(a.quantity), 0) into v_used from dispatch_allocations a
      join dispatch_lines l on l.id = a.line_id join dispatches d on d.id = a.dispatch_id
      where a.org_id = p_org_id and a.source_id = p_source_id and d.order_key = v_dispatch.order_key
        and l.order_line_key = v_line.order_line_key;
    if v_used + v_line.quantity > v_line.ordered_quantity then
      raise exception 'dispatch allocation exceeds original order line quantity';
    end if;
  end loop;
  insert into dispatch_invoice_parts(org_id, source_id, dispatch_id, claim_key, source_revision)
    values (p_org_id, p_source_id, p_dispatch_id, p_claim_key, p_revision) returning * into v_part;
  insert into dispatch_allocations(org_id, source_id, dispatch_id, part_id, line_id, quantity)
    select p_org_id, p_source_id, p_dispatch_id, v_part.id, id, quantity from dispatch_lines
      where dispatch_id = p_dispatch_id and active;
  return v_part.id;
end $$;

-- Shopify adapter boundary. Never derive org or connection authority from p_payload.
create function bind_shopify_dispatch_source(p_org_id uuid, p_connection_key text) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare v_source dispatch_sources%rowtype;
begin
  if p_connection_key is null or p_connection_key !~ '^[a-z0-9][a-z0-9-]*\.myshopify\.com$' then
    raise exception 'a canonical Shopify shop domain is required';
  end if;
  perform pg_advisory_xact_lock(hashtextextended(p_org_id::text || ':shopify-binding', 0));
  select * into v_source from dispatch_sources where org_id = p_org_id and provider = 'shopify';
  if found then
    if v_source.connection_key <> p_connection_key or not v_source.enabled then
      raise exception 'Shopify connection binding mismatch or disabled source';
    end if;
    return v_source.id;
  end if;
  insert into dispatch_sources(org_id, provider, connection_key)
    values (p_org_id, 'shopify', p_connection_key) returning id into v_source.id;
  return v_source.id;
end $$;

alter table shopify_fulfillments add column dispatch_id uuid;
alter table shopify_fulfillments add constraint shopify_fulfillments_dispatch_scope
  foreign key (org_id, dispatch_id) references dispatches(org_id, id);

create function project_shopify_dispatch(p_org_id uuid, p_connection_key text, p_payload jsonb) returns uuid
language plpgsql security definer set search_path = pg_catalog, public as $$
declare
  v_source_id uuid; v_order shopify_orders%rowtype; v_original shopify_order_lines%rowtype;
  v_line jsonb; v_lines jsonb := '[]'; v_reason text; v_status text;
  v_revision timestamptz; v_occurred_at timestamptz; v_id uuid; v_dispatch dispatches%rowtype; v_quantity int;
begin
  v_source_id := bind_shopify_dispatch_source(p_org_id, p_connection_key);
  if jsonb_typeof(p_payload) <> 'object' or coalesce(p_payload->>'id', '') !~ '^[0-9]+$'
    or coalesce(p_payload->>'order_id', '') !~ '^[0-9]+$' then
    raise exception 'malformed Shopify fulfillment identity';
  end if;
  -- No wall-clock fallback: an unversioned event cannot overwrite a known revision.
  if coalesce(p_payload->>'updated_at', '') !~ '^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$' then
    raise exception 'Shopify fulfillment updated_at with timezone is required';
  end if;
  v_revision := (p_payload->>'updated_at')::timestamptz;
  if p_payload->>'created_at' is not null then
    if (p_payload->>'created_at') !~ '^\d{4}-\d{2}-\d{2}T.*(Z|[+-]\d{2}:\d{2})$' then
      raise exception 'Shopify fulfillment created_at must include a timezone';
    end if;
    v_occurred_at := (p_payload->>'created_at')::timestamptz;
  end if;
  select * into v_order from shopify_orders where org_id = p_org_id and shopify_order_id = p_payload->>'order_id';
  if not found then raise exception 'Shopify order not yet synced: %', p_payload->>'order_id'; end if;
  if exists (select 1 from shopify_fulfillments where org_id = p_org_id
    and shopify_fulfillment_id = p_payload->>'id' and shopify_order_id <> v_order.id) then
    raise exception 'Shopify fulfillment cannot move to a different order';
  end if;
  v_status := case p_payload->>'status' when 'success' then 'succeeded' when 'cancelled' then 'cancelled'
    when 'pending' then 'pending' when 'open' then 'pending' when 'failure' then 'failed'
    when 'error' then 'failed' else 'unknown' end;
  if jsonb_typeof(p_payload->'line_items') is distinct from 'array' then
    v_reason := 'missing_or_malformed_lines';
  else
    for v_line in select value from jsonb_array_elements(p_payload->'line_items') loop
      if jsonb_typeof(v_line) <> 'object' or coalesce(v_line->>'id', '') !~ '^[0-9]+$'
        or jsonb_typeof(v_line->'quantity') is distinct from 'number'
        or coalesce(v_line->>'quantity', '') !~ '^[1-9][0-9]{0,8}$' then
        v_reason := 'malformed_line'; exit;
      end if;
      select * into v_original from shopify_order_lines where org_id = p_org_id
        and shopify_order_id = v_order.id and shopify_line_id = v_line->>'id';
      if not found then raise exception 'Shopify order line not yet synced: %', v_line->>'id'; end if;
      v_quantity := (v_line->>'quantity')::int;
      if v_quantity > v_original.quantity then v_reason := 'quantity_exceeds_order'; exit; end if;
      if exists (select 1 from jsonb_array_elements(v_lines) x where x->>'source_line_key' = v_line->>'id') then
        v_reason := 'duplicate_source_line'; exit;
      end if;
      -- line_items.id identifies the original order line. The separate
      -- fulfillment_line_item_id, when supplied, stays in immutable source evidence.
      v_lines := v_lines || jsonb_build_array(jsonb_build_object('source_line_key', v_line->>'id',
        'order_line_key', v_original.id::text, 'item_key', nullif(btrim(v_original.sku), ''),
        'quantity', v_quantity, 'ordered_quantity', v_original.quantity));
    end loop;
  end if;
  if exists (select 1 from shopify_fulfillments f
    join fulfillment_events e on e.shopify_fulfillment_id = f.id and e.org_id = p_org_id
    join invoices i on i.fulfillment_event_id = e.id and i.org_id = p_org_id
    where f.org_id = p_org_id and f.shopify_fulfillment_id = p_payload->>'id') then
    v_reason := 'legacy_invoice_requires_reconciliation';
  end if;
  if v_reason is not null then v_lines := '[]'; end if;
  v_id := project_dispatch(p_org_id, v_source_id, p_payload->>'id', v_order.id::text,
    v_revision, v_status, p_payload->>'location_id', v_lines, v_reason, p_payload, v_occurred_at);
  select * into v_dispatch from dispatches where id = v_id;
  -- Same transaction/lock as normalized state. A stale/conflicting event cannot roll
  -- back the legacy header used by routing. Keep original canonical UUIDs on upsert.
  if v_dispatch.source_revision = v_revision and v_dispatch.reason is distinct from 'conflicting_source_revision'
    and v_dispatch.state <> 'correction_required' then
    insert into shopify_fulfillments(org_id, shopify_fulfillment_id, shopify_order_id, location_id,
      status, tracking_company, tracking_numbers, raw, occurred_at, dispatch_id)
    values (p_org_id, p_payload->>'id', v_order.id, p_payload->>'location_id', coalesce(p_payload->>'status', 'unknown'),
      p_payload->>'tracking_company', case when jsonb_typeof(p_payload->'tracking_numbers') = 'array'
        then array(select jsonb_array_elements_text(p_payload->'tracking_numbers')) else '{}' end,
      p_payload, coalesce(v_occurred_at, v_revision), v_id)
    on conflict (org_id, shopify_fulfillment_id) do update set location_id = excluded.location_id,
      status = excluded.status, tracking_company = excluded.tracking_company, tracking_numbers = excluded.tracking_numbers,
      raw = excluded.raw, dispatch_id = excluded.dispatch_id, synced_at = now();
  end if;
  return v_id;
end $$;

-- Explicitly remove Supabase default grants as well as PostgreSQL PUBLIC execution.
-- Trusted server service_role can read these models and invoke bounded RPCs, but cannot
-- bypass allocation/history rules with direct writes. No app.org_id browser policy.
do $$
declare t text; r text; f regprocedure;
begin
  foreach t in array array['dispatch_sources','dispatches','dispatch_revisions','dispatch_lines',
    'dispatch_invoice_parts','dispatch_allocations','dispatch_corrections'] loop
    execute format('alter table %I enable row level security', t);
    execute format('revoke all on table %I from public', t);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on table %I from %I', t, r);
        if r = 'service_role' then execute format('grant select on table %I to service_role', t); end if;
      end if;
    end loop;
  end loop;
  for f in select oid::regprocedure from pg_proc where pronamespace = 'public'::regnamespace
    and proname in ('project_dispatch','claim_dispatch','bind_shopify_dispatch_source','project_shopify_dispatch',
      'reject_dispatch_history_mutation') loop
    execute format('revoke all on function %s from public', f);
    foreach r in array array['anon','authenticated','service_role'] loop
      if exists (select 1 from pg_roles where rolname = r) then
        execute format('revoke all on function %s from %I', f, r);
        if r = 'service_role' then execute format('grant execute on function %s to service_role', f); end if;
      end if;
    end loop;
  end loop;
end $$;
