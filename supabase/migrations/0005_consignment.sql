-- 0005_consignment — consignment_movements (v1.0 substrate; v1.1 is deferred and is gated on
-- the order-entry decision in §12). This table captures movement of stock to/from venue
-- locations so the consignment slice can be implemented without further schema changes.

create type consignment_direction as enum ('out', 'return', 'sold');

create table consignment_movements (
  id                      uuid primary key default gen_random_uuid(),
  org_id                  uuid not null references orgs(id) on delete restrict,
  account_id              uuid references accounts(id) on delete restrict,
  location_id             text,                                   -- Shopify location id
  location_name           text,
  shopify_fulfillment_id  uuid references shopify_fulfillments(id) on delete set null,
  product_id              uuid references products(id) on delete restrict,
  sku                     text,
  quantity                int not null check (quantity > 0),
  direction               consignment_direction not null,
  occurred_at             timestamptz not null,
  notes                   text,
  created_at              timestamptz not null default now()
);

create index consignment_movements_org_idx on consignment_movements(org_id);
create index consignment_movements_account_idx on consignment_movements(account_id);
create index consignment_movements_location_idx on consignment_movements(org_id, location_id);

alter table consignment_movements enable row level security;

create policy consignment_movements_org on consignment_movements
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);
