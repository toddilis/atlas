-- 0015_pr_f_statements — account statement snapshots.
--
-- A statement is the canonical record of an account's billing position at a moment in
-- time. It freezes:
--   - opening balance at period_start (AR at start of period)
--   - charges in [period_start, as_of_at) (invoices issued in period, gross)
--   - payments in [period_start, as_of_at) (payments received in period, gross)
--   - closing balance at as_of_at (= opening + charges - payments, by construction)
--   - aging breakdown of the closing balance (current / 30 / 60 / 90+ days)
--   - per-row lines: opening, each invoice issued, each payment received, closing
--
-- The snapshot semantics matter for audit — a statement sent to a customer must reflect
-- the data at the moment of generation, even if later transactions change things. So
-- the totals are persisted, not recomputed.
--
-- Statements are immutable once generated (state='draft' until sent → 'sent'; void only
-- on operator action). Future statements for the same period get a new row, not an
-- overwrite. The (org_id, account_id, period_start_at, period_end_at) uniqueness check
-- is intentionally absent — month-end + a redraft mid-month should both be possible.

create type statement_state as enum ('draft', 'sent', 'voided');
create type statement_line_type as enum ('opening', 'invoice', 'payment', 'closing');

-- ---------- statements ----------
create table statements (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references orgs(id) on delete restrict,
  account_id               uuid not null references accounts(id) on delete restrict,
  state                    statement_state not null default 'draft',
  currency                 char(3) not null,

  period_start_at          timestamptz not null,
  as_of_at                 timestamptz not null,

  opening_balance_cents    bigint not null check (opening_balance_cents >= 0),
  charges_cents            bigint not null check (charges_cents >= 0),
  payments_cents           bigint not null check (payments_cents >= 0),
  closing_balance_cents    bigint not null check (closing_balance_cents >= 0),

  -- Aging buckets of the closing balance (current = not overdue by issued/due date,
  -- 30/60/90 = bands of overdue days). Sum equals closing_balance_cents.
  aging_current_cents      bigint not null default 0 check (aging_current_cents >= 0),
  aging_30_cents           bigint not null default 0 check (aging_30_cents >= 0),
  aging_60_cents           bigint not null default 0 check (aging_60_cents >= 0),
  aging_90_plus_cents      bigint not null default 0 check (aging_90_plus_cents >= 0),

  generated_at             timestamptz not null default now(),
  generated_by_agent       text,
  sent_at                  timestamptz,
  notes                    text,

  check (period_start_at <= as_of_at)
);

create index statements_org_idx       on statements(org_id);
create index statements_account_idx   on statements(org_id, account_id, as_of_at desc);
create index statements_state_idx     on statements(org_id, state);

-- ---------- statement_lines ----------
create table statement_lines (
  id                       uuid primary key default gen_random_uuid(),
  org_id                   uuid not null references orgs(id) on delete restrict,
  statement_id             uuid not null references statements(id) on delete cascade,
  line_type                statement_line_type not null,

  -- Ordering within the statement (1..n). The opening line is always 1, closing is the
  -- highest. Invoice/payment lines sort by occurred_at then line_type (invoice before
  -- payment on the same day, by convention).
  sort_order               integer not null,

  occurred_at              timestamptz not null,
  description              text not null,

  -- For invoice/payment lines, reference the source row. Nullable for opening/closing.
  reference_type           text,
  reference_id             uuid,

  -- Signed cents. Positive = increases AR (invoice issuance), negative = decreases AR
  -- (payment received). For opening/closing lines, this is the balance itself (always
  -- non-negative; checked at the statements level).
  amount_cents             bigint not null,

  -- Running balance after this line.
  running_balance_cents    bigint not null check (running_balance_cents >= 0),

  unique (statement_id, sort_order)
);

create index statement_lines_org_idx       on statement_lines(org_id);
create index statement_lines_statement_idx on statement_lines(statement_id, sort_order);

-- ---------- RLS ----------
alter table statements      enable row level security;
alter table statement_lines enable row level security;

create policy statements_org on statements
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);
create policy statement_lines_org on statement_lines
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

-- ---------- aging bucket helper ----------
-- Pure SQL function — pinned search_path. Mirrors src/platform/pricing/aging.ts.
-- Bands:
--   <= 0       → current (not overdue)
--   1..30      → 30 (1-30 days overdue)
--   31..60     → 60 (31-60 days overdue)
--   > 60       → 90+ (over 60 days overdue; we name the bucket '90_plus' because that's
--                     the conventional outer band, even though the cutoff is 60 not 90)
create or replace function age_bucket(p_overdue_days integer)
returns text
language plpgsql
immutable
security invoker
set search_path = pg_catalog, public
as $$
begin
  if p_overdue_days is null or p_overdue_days <= 0 then
    return 'current';
  elsif p_overdue_days <= 30 then
    return '30';
  elsif p_overdue_days <= 60 then
    return '60';
  else
    return '90_plus';
  end if;
end $$;

-- ---------- generate_statement_atomic ----------
-- Generates a statement snapshot for an account over [p_period_start_at, p_as_of_at).
-- Single transaction: inserts statements + statement_lines.
--
-- Balance derivation:
--   For each invoice in state != 'void' with issued_at < as_of_at:
--     outstanding = total_cents - coalesce(sum(payments where received_at < as_of_at), 0)
--   AR at as_of_at = sum(outstanding > 0) over all such invoices
--   AR at period_start_at = same calc with as_of_at = period_start_at
--
-- Charges/payments in period are summed gross (no signing) so the operator sees activity
-- totals separately from net balance change.
create or replace function generate_statement_atomic(
  p_org_id            uuid,
  p_account_id        uuid,
  p_period_start_at   timestamptz,
  p_as_of_at          timestamptz,
  p_generated_by      text default 'controller'
) returns table (
  statement_id  uuid,
  closing_balance_cents bigint,
  line_count    integer
)
language plpgsql
security invoker
set search_path = pg_catalog, public
as $$
declare
  v_now                  timestamptz := now();
  v_currency             char(3);
  v_opening_balance      bigint := 0;
  v_charges              bigint := 0;
  v_payments             bigint := 0;
  v_closing_balance      bigint := 0;
  v_aging_current        bigint := 0;
  v_aging_30             bigint := 0;
  v_aging_60             bigint := 0;
  v_aging_90_plus        bigint := 0;
  v_statement_id         uuid;
  v_sort                 integer := 1;
  v_inv                  record;
  v_pay                  record;
  v_running              bigint := 0;
begin
  if p_org_id is null or p_account_id is null then
    raise exception 'generate_statement_atomic: org/account required';
  end if;
  if p_period_start_at is null or p_as_of_at is null or p_period_start_at > p_as_of_at then
    raise exception 'generate_statement_atomic: invalid period';
  end if;

  -- Account currency drives the statement currency. Mixed-currency accounts aren't
  -- supported in v1.
  select currency into v_currency from accounts
    where id = p_account_id and org_id = p_org_id;
  if v_currency is null then
    raise exception 'generate_statement_atomic: account % not found in org %',
      p_account_id, p_org_id;
  end if;

  -- Opening balance: AR at period_start_at.
  select coalesce(sum(greatest(0, i.total_cents - coalesce(p.paid, 0))), 0)
    into v_opening_balance
    from invoices i
    left join lateral (
      select sum(amount_cents) as paid from payments
       where org_id = p_org_id and invoice_id = i.id
         and received_at < p_period_start_at
    ) p on true
   where i.org_id = p_org_id
     and i.account_id = p_account_id
     and i.state <> 'void'
     and i.issued_at is not null
     and i.issued_at < p_period_start_at;

  -- Charges in period: invoices issued in [period_start, as_of).
  select coalesce(sum(total_cents), 0) into v_charges
    from invoices
   where org_id = p_org_id
     and account_id = p_account_id
     and state <> 'void'
     and issued_at >= p_period_start_at
     and issued_at <  p_as_of_at;

  -- Payments in period: payments received in [period_start, as_of).
  select coalesce(sum(amount_cents), 0) into v_payments
    from payments
   where org_id = p_org_id
     and invoice_id in (
       select id from invoices
        where org_id = p_org_id and account_id = p_account_id
     )
     and received_at >= p_period_start_at
     and received_at <  p_as_of_at;

  v_closing_balance := v_opening_balance + v_charges - v_payments;
  if v_closing_balance < 0 then
    -- Customer is in credit. Statements show 0 (the credit lives elsewhere — refunds,
    -- credit notes, etc., out of scope for v1). Log so a real credit gets investigated.
    raise notice 'generate_statement_atomic: negative balance % for account % (clamping to 0)',
      v_closing_balance, p_account_id;
    v_closing_balance := 0;
  end if;

  -- Aging breakdown: for each non-void invoice with issued_at < as_of, age by its
  -- due_at (or issued_at if no due_at) and bucket the remaining outstanding.
  for v_inv in
    select i.id,
           i.total_cents,
           coalesce(i.due_at, i.issued_at) as age_anchor,
           coalesce((
             select sum(amount_cents) from payments
              where org_id = p_org_id and invoice_id = i.id and received_at < p_as_of_at
           ), 0) as paid_to_date
      from invoices i
     where i.org_id = p_org_id
       and i.account_id = p_account_id
       and i.state <> 'void'
       and i.issued_at is not null
       and i.issued_at < p_as_of_at
  loop
    declare
      v_outstanding bigint := v_inv.total_cents - v_inv.paid_to_date;
      v_overdue_days integer;
    begin
      if v_outstanding <= 0 then
        continue;
      end if;
      v_overdue_days := extract(epoch from (p_as_of_at - v_inv.age_anchor)) / 86400;
      case age_bucket(v_overdue_days)
        when 'current' then v_aging_current   := v_aging_current   + v_outstanding;
        when '30'      then v_aging_30        := v_aging_30        + v_outstanding;
        when '60'      then v_aging_60        := v_aging_60        + v_outstanding;
        else                v_aging_90_plus   := v_aging_90_plus   + v_outstanding;
      end case;
    end;
  end loop;

  -- Insert the statement row.
  insert into statements (
    org_id, account_id, currency, period_start_at, as_of_at,
    opening_balance_cents, charges_cents, payments_cents, closing_balance_cents,
    aging_current_cents, aging_30_cents, aging_60_cents, aging_90_plus_cents,
    generated_at, generated_by_agent
  ) values (
    p_org_id, p_account_id, v_currency, p_period_start_at, p_as_of_at,
    v_opening_balance, v_charges, v_payments, v_closing_balance,
    v_aging_current, v_aging_30, v_aging_60, v_aging_90_plus,
    v_now, p_generated_by
  )
  returning id into v_statement_id;

  -- Opening line.
  v_running := v_opening_balance;
  insert into statement_lines (
    org_id, statement_id, line_type, sort_order, occurred_at,
    description, amount_cents, running_balance_cents
  ) values (
    p_org_id, v_statement_id, 'opening', v_sort, p_period_start_at,
    'Opening balance', v_opening_balance, v_running
  );
  v_sort := v_sort + 1;

  -- Invoice + payment lines, interleaved by occurred_at.
  for v_inv in
    select 'invoice'::text as kind,
           i.id            as ref_id,
           i.invoice_number as label,
           i.issued_at     as occurred_at,
           i.total_cents   as amount
      from invoices i
     where i.org_id = p_org_id
       and i.account_id = p_account_id
       and i.state <> 'void'
       and i.issued_at >= p_period_start_at
       and i.issued_at <  p_as_of_at
    union all
    select 'payment'::text,
           p.id,
           coalesce('Payment ' || left(p.stripe_payment_id, 12), 'Payment'),
           p.received_at,
           -p.amount_cents
      from payments p
      join invoices i on i.id = p.invoice_id and i.org_id = p_org_id
     where p.org_id = p_org_id
       and i.account_id = p_account_id
       and p.received_at >= p_period_start_at
       and p.received_at <  p_as_of_at
    order by occurred_at, kind
  loop
    v_running := greatest(0, v_running + v_inv.amount);
    insert into statement_lines (
      org_id, statement_id, line_type, sort_order, occurred_at,
      description, reference_type, reference_id, amount_cents, running_balance_cents
    ) values (
      p_org_id, v_statement_id,
      case when v_inv.kind = 'invoice' then 'invoice'::statement_line_type
           else 'payment'::statement_line_type end,
      v_sort, v_inv.occurred_at,
      v_inv.label, v_inv.kind, v_inv.ref_id,
      v_inv.amount, v_running
    );
    v_sort := v_sort + 1;
  end loop;

  -- Closing line.
  insert into statement_lines (
    org_id, statement_id, line_type, sort_order, occurred_at,
    description, amount_cents, running_balance_cents
  ) values (
    p_org_id, v_statement_id, 'closing', v_sort, p_as_of_at,
    'Closing balance', v_closing_balance, v_closing_balance
  );

  return query select v_statement_id, v_closing_balance, v_sort;
end $$;
