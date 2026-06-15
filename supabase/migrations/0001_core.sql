-- 0001_core — orgs, accounts (B2B), products, price_books, price_book_entries.
-- Every table is org-scoped + RLS-protected. The Controller filters Shopify orders to B2B
-- via the link from shopify_customers → accounts (see 0002 / Seam 2).

create extension if not exists "pgcrypto";

-- ---------- orgs ----------
create table orgs (
  id            uuid primary key default gen_random_uuid(),
  slug          text not null unique,
  display_name  text not null,
  base_currency char(3) not null default 'NZD',
  created_at    timestamptz not null default now()
);

-- ---------- accounts (B2B wholesale accounts) ----------
-- NOT the same as shopify_customers (Seam 2). A wholesale account is the legal/billing entity
-- behind a venue/club; it can be linked to one or more shopify_customers.
create table accounts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete restrict,
  name          text not null,
  legal_name    text,
  status        text not null default 'active' check (status in ('active','dormant','closed')),
  payment_terms_days int not null default 14,
  currency      char(3) not null default 'NZD',
  billing_email text,
  notes         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (org_id, name)
);

create index accounts_org_idx on accounts(org_id);

-- ---------- products ----------
-- Atlas's canonical product (SKU-level). Linked to shopify_products by shopify_product_id when
-- a Shopify origin exists; pricing lives in price_books below.
create table products (
  id                uuid primary key default gen_random_uuid(),
  org_id            uuid not null references orgs(id) on delete restrict,
  sku               text not null,
  display_name      text not null,
  shopify_product_id   text,
  shopify_variant_id   text,
  unit              text not null default 'each',
  active            boolean not null default true,
  created_at        timestamptz not null default now(),
  unique (org_id, sku)
);

create index products_org_idx on products(org_id);
create index products_shopify_variant_idx on products(shopify_variant_id);

-- ---------- price_books ----------
-- A price book is a named, account-scoped (or default) price list. Pricing resolution is
-- deterministic: account → account-bound price book → default; missing entry = fail loud
-- (Phase 1 — Controller invariant).
create table price_books (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete restrict,
  name          text not null,
  is_default    boolean not null default false,
  currency      char(3) not null default 'NZD',
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (org_id, name)
);

create unique index price_books_one_default_per_org
  on price_books(org_id) where is_default;

-- account → price book binding (one active book per account at a time)
create table account_price_books (
  account_id    uuid not null references accounts(id) on delete cascade,
  price_book_id uuid not null references price_books(id) on delete restrict,
  effective_from timestamptz not null default now(),
  primary key (account_id, price_book_id)
);

-- ---------- price_book_entries ----------
-- One row per (price_book, product). Currency follows the price book.
create table price_book_entries (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete restrict,
  price_book_id uuid not null references price_books(id) on delete cascade,
  product_id    uuid not null references products(id) on delete restrict,
  unit_price_cents bigint not null check (unit_price_cents >= 0),
  created_at    timestamptz not null default now(),
  unique (price_book_id, product_id)
);

create index pbe_org_idx on price_book_entries(org_id);
create index pbe_book_idx on price_book_entries(price_book_id);

-- ---------- RLS ----------
alter table orgs                 enable row level security;
alter table accounts             enable row level security;
alter table products             enable row level security;
alter table price_books          enable row level security;
alter table account_price_books  enable row level security;
alter table price_book_entries   enable row level security;

-- Service-role bypasses RLS. Authenticated access is restricted to the caller's org_id, which
-- is set via `set_config('app.org_id', ...)` at session start by the API layer.
create policy orgs_self on orgs
  for select using (id = current_setting('app.org_id', true)::uuid);

create policy accounts_org on accounts
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy products_org on products
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy price_books_org on price_books
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy account_price_books_org on account_price_books
  for all using (
    exists (select 1 from accounts a where a.id = account_price_books.account_id
            and a.org_id = current_setting('app.org_id', true)::uuid)
  );

create policy price_book_entries_org on price_book_entries
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);
