-- 0002_canonical_shopify — Seams 1 & 2.
-- Seam 1: ALL Shopify orders + ALL Shopify customers land here, not just B2B. The Controller
--         filters to B2B downstream; Growth (later) reads DTC from the same tables.
-- Seam 2: shopify_customers is a separate entity from accounts. The link is optional and
--         many-to-one (multiple shopify_customers can point at one B2B account).

-- ---------- shopify_customers ----------
create table shopify_customers (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references orgs(id) on delete restrict,
  shopify_customer_id text not null,
  email              text,
  first_name         text,
  last_name          text,
  default_address    jsonb,
  tags               text[] not null default '{}',
  account_id         uuid references accounts(id) on delete set null,  -- Seam 2: optional link
  raw                jsonb not null,                                    -- full source payload
  created_at_source  timestamptz,
  updated_at_source  timestamptz,
  synced_at          timestamptz not null default now(),
  unique (org_id, shopify_customer_id)
);

create index shopify_customers_org_idx on shopify_customers(org_id);
create index shopify_customers_account_idx on shopify_customers(account_id);

-- ---------- shopify_orders ----------
create table shopify_orders (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references orgs(id) on delete restrict,
  shopify_order_id    text not null,
  shopify_order_name  text,                  -- e.g. #1042
  shopify_customer_id text,                  -- raw id, resolved via shopify_customers
  currency            char(3) not null,
  subtotal_cents      bigint not null check (subtotal_cents >= 0),
  total_tax_cents     bigint not null default 0 check (total_tax_cents >= 0),
  total_cents         bigint not null check (total_cents >= 0),
  financial_status    text,
  fulfillment_status  text,
  tags                text[] not null default '{}',
  raw                 jsonb not null,
  placed_at           timestamptz,
  updated_at_source   timestamptz,
  synced_at           timestamptz not null default now(),
  unique (org_id, shopify_order_id)
);

create index shopify_orders_org_idx on shopify_orders(org_id);
create index shopify_orders_customer_idx on shopify_orders(org_id, shopify_customer_id);
create index shopify_orders_placed_at_idx on shopify_orders(placed_at desc);

-- ---------- shopify_order_lines ----------
create table shopify_order_lines (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references orgs(id) on delete restrict,
  shopify_order_id   uuid not null references shopify_orders(id) on delete cascade,
  shopify_line_id    text not null,
  shopify_variant_id text,
  sku                text,
  title              text,
  quantity           int not null check (quantity > 0),
  unit_price_cents   bigint not null check (unit_price_cents >= 0),
  total_cents        bigint not null check (total_cents >= 0),
  raw                jsonb not null,
  unique (shopify_order_id, shopify_line_id)
);

create index shopify_order_lines_org_idx on shopify_order_lines(org_id);
create index shopify_order_lines_sku_idx on shopify_order_lines(org_id, sku);

-- ---------- shopify_fulfillments ----------
-- Source of truth for fulfillment events from Shopify. The fulfillment webhook lands here
-- before the Controller derives a billable event in 0003.
create table shopify_fulfillments (
  id                    uuid primary key default gen_random_uuid(),
  org_id                uuid not null references orgs(id) on delete restrict,
  shopify_fulfillment_id text not null,
  shopify_order_id      uuid not null references shopify_orders(id) on delete restrict,
  location_id           text,                 -- routing key (venue / main / etc.)
  location_name         text,
  status                text not null,        -- success, cancelled, failure, etc.
  tracking_company      text,
  tracking_numbers      text[] not null default '{}',
  raw                   jsonb not null,
  occurred_at           timestamptz not null,
  synced_at             timestamptz not null default now(),
  unique (org_id, shopify_fulfillment_id)
);

create index shopify_fulfillments_org_idx on shopify_fulfillments(org_id);
create index shopify_fulfillments_order_idx on shopify_fulfillments(shopify_order_id);
create index shopify_fulfillments_location_idx on shopify_fulfillments(org_id, location_id);

-- ---------- RLS ----------
alter table shopify_customers     enable row level security;
alter table shopify_orders        enable row level security;
alter table shopify_order_lines   enable row level security;
alter table shopify_fulfillments  enable row level security;

create policy shopify_customers_org on shopify_customers
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy shopify_orders_org on shopify_orders
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy shopify_order_lines_org on shopify_order_lines
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy shopify_fulfillments_org on shopify_fulfillments
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);
