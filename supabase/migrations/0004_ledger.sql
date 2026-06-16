-- 0004_ledger — independent double-entry ledger.
-- Seam 3: every transaction carries a `channel` and a `source`, so the posting engine is a
-- strategy keyed by source/channel — DTC adds without migration.
-- Invariant: ledger_lines per transaction must sum to zero (enforced by trigger).

create type ledger_account_type as enum ('asset', 'liability', 'equity', 'revenue', 'expense');
create type ledger_source       as enum (
  'invoice_issued', 'invoice_voided', 'payment_received', 'payment_refunded',
  'payout_received', 'manual_adjustment'
);

-- ---------- ledger_accounts ----------
create table ledger_accounts (
  id            uuid primary key default gen_random_uuid(),
  org_id        uuid not null references orgs(id) on delete restrict,
  code          text not null,                            -- 1000, 1100, 2200, 4000, ...
  display_name  text not null,
  type          ledger_account_type not null,
  active        boolean not null default true,
  created_at    timestamptz not null default now(),
  unique (org_id, code)
);

create index ledger_accounts_org_idx on ledger_accounts(org_id);

-- ---------- ledger_transactions ----------
create table ledger_transactions (
  id               uuid primary key default gen_random_uuid(),
  org_id           uuid not null references orgs(id) on delete restrict,
  channel          billing_channel not null,                  -- Seam 3
  source           ledger_source not null,
  source_ref       uuid,                                       -- nullable subledger reference
  source_ref_type  text,                                       -- 'invoice', 'payment', 'payout', etc.
  description      text,
  occurred_at      timestamptz not null,
  posted_at        timestamptz not null default now(),
  posted_by_agent  text                                        -- agent name; null = system
);

create index ledger_transactions_org_idx on ledger_transactions(org_id);
create index ledger_transactions_source_ref_idx on ledger_transactions(source_ref);
create index ledger_transactions_channel_idx on ledger_transactions(org_id, channel);

-- ---------- ledger_lines ----------
-- Signed cents: positive = debit, negative = credit (or use separate debit/credit columns —
-- we use signed for arithmetic simplicity; the sum-to-zero invariant is enforced below).
create table ledger_lines (
  id                  uuid primary key default gen_random_uuid(),
  org_id              uuid not null references orgs(id) on delete restrict,
  transaction_id      uuid not null references ledger_transactions(id) on delete cascade,
  ledger_account_id   uuid not null references ledger_accounts(id) on delete restrict,
  amount_cents        bigint not null,                              -- signed; balance check below
  currency            char(3) not null,
  memo                text
);

create index ledger_lines_org_idx on ledger_lines(org_id);
create index ledger_lines_txn_idx on ledger_lines(transaction_id);
create index ledger_lines_account_idx on ledger_lines(ledger_account_id);

-- ---------- balanced-transaction invariant ----------
-- Trigger fires on insert/update/delete of any line; if the parent transaction's lines do not
-- sum to zero, the operation is rolled back. Deferred to end-of-transaction so multi-line
-- inserts inside a single DB transaction are allowed.
create or replace function enforce_ledger_balance() returns trigger
language plpgsql as $$
declare
  txn_id uuid := coalesce(new.transaction_id, old.transaction_id);
  total  bigint;
begin
  select coalesce(sum(amount_cents), 0) into total
  from ledger_lines
  where transaction_id = txn_id;

  if total <> 0 then
    raise exception
      'ledger imbalance: transaction % lines sum to % (must be 0)', txn_id, total;
  end if;
  return null;
end $$;

create constraint trigger ledger_balance_check
  after insert or update or delete on ledger_lines
  deferrable initially deferred
  for each row execute function enforce_ledger_balance();

-- ---------- RLS ----------
alter table ledger_accounts     enable row level security;
alter table ledger_transactions enable row level security;
alter table ledger_lines        enable row level security;

create policy ledger_accounts_org on ledger_accounts
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy ledger_transactions_org on ledger_transactions
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy ledger_lines_org on ledger_lines
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);
