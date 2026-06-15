-- 0003_billing — fulfillment_events, invoices (with channel), invoice_lines, payments.
-- `channel` is set everywhere so the DTC slice can later be added without migration.

create type fulfillment_route as enum ('wholesale', 'consignment', 'ignored');
create type invoice_state as enum (
  'draft', 'pending_approval', 'issued', 'paid', 'partial', 'overdue', 'void'
);
create type billing_channel as enum ('wholesale', 'consignment', 'dtc', 'internal');

-- ---------- fulfillment_events ----------
-- The Controller's normalized view of a Shopify fulfillment after location routing.
-- One row per shopify_fulfillment that passed routing (ignored fulfillments are also recorded
-- so we can audit why a Shopify fulfillment did not produce an invoice).
create table fulfillment_events (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references orgs(id) on delete restrict,
  shopify_fulfillment_id   uuid not null references shopify_fulfillments(id) on delete restrict,
  shopify_order_id         uuid not null references shopify_orders(id) on delete restrict,
  account_id               uuid references accounts(id) on delete restrict,  -- null when ignored or DTC
  route                    fulfillment_route not null,
  reason                   text,                                              -- routing rationale
  occurred_at              timestamptz not null,
  created_at               timestamptz not null default now(),
  unique (org_id, shopify_fulfillment_id)
);

create index fulfillment_events_org_idx on fulfillment_events(org_id);
create index fulfillment_events_account_idx on fulfillment_events(account_id);
create index fulfillment_events_route_idx on fulfillment_events(org_id, route);

-- ---------- invoices ----------
create table invoices (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references orgs(id) on delete restrict,
  channel             billing_channel not null default 'wholesale',
  account_id          uuid references accounts(id) on delete restrict, -- null for DTC channel
  invoice_number      text not null,             -- ATL-VICE-0001
  state               invoice_state not null default 'draft',
  currency            char(3) not null,
  subtotal_cents      bigint not null check (subtotal_cents >= 0),
  tax_cents           bigint not null default 0 check (tax_cents >= 0),
  total_cents         bigint not null check (total_cents >= 0),
  fulfillment_event_id uuid references fulfillment_events(id) on delete restrict,
  issued_at           timestamptz,
  due_at              timestamptz,
  paid_at             timestamptz,
  stripe_invoice_id   text,                       -- populated when issued via outbox in Phase 1
  notes               text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  unique (org_id, invoice_number)
);

create index invoices_org_idx on invoices(org_id);
create index invoices_account_idx on invoices(account_id);
create index invoices_state_idx on invoices(org_id, state);
create index invoices_channel_idx on invoices(org_id, channel);

-- ---------- invoice_lines ----------
create table invoice_lines (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references orgs(id) on delete restrict,
  invoice_id       uuid not null references invoices(id) on delete cascade,
  product_id       uuid references products(id) on delete restrict,
  description      text not null,
  quantity         numeric(14,4) not null check (quantity > 0),
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  total_cents      bigint not null check (total_cents >= 0)
);

create index invoice_lines_org_idx on invoice_lines(org_id);
create index invoice_lines_invoice_idx on invoice_lines(invoice_id);

-- ---------- payments ----------
create table payments (
  id                 uuid primary key default gen_random_uuid(),
  org_id             uuid not null references orgs(id) on delete restrict,
  invoice_id         uuid not null references invoices(id) on delete restrict,
  amount_cents       bigint not null check (amount_cents > 0),
  currency           char(3) not null,
  method             text not null,                              -- 'stripe', 'bank_transfer', etc.
  stripe_payment_id  text,
  received_at        timestamptz not null,
  raw                jsonb,
  created_at         timestamptz not null default now()
);

create index payments_org_idx on payments(org_id);
create index payments_invoice_idx on payments(invoice_id);

-- ---------- RLS ----------
alter table fulfillment_events enable row level security;
alter table invoices            enable row level security;
alter table invoice_lines       enable row level security;
alter table payments            enable row level security;

create policy fulfillment_events_org on fulfillment_events
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy invoices_org on invoices
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy invoice_lines_org on invoice_lines
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy payments_org on payments
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);
