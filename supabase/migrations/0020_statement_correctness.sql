-- 0020_statement_correctness — Phase 2.5 PR-N.
--
-- Review findings on statements (0015), all confirmed:
--   1. The outer aging bucket was labelled '90_plus' but captured everything over 60
--      days — there was no 61–90 band at all. A 75-day-overdue invoice reported as 90+.
--   2. Closing balance was derived activity-based (opening + charges − payments, clamped
--      at 0) while the aging buckets were derived per-invoice (each clamped at 0). The
--      schema comment asserted "sum equals closing_balance_cents" but nothing enforced
--      it, and overpayments made the two derivations genuinely diverge.
--   3. Overdue days used elapsed-time division (extract(epoch)/86400) with no timezone —
--      and the numeric→integer assignment ROUNDS in PL/pgSQL where the TS mirror floors,
--      so the two sides of the deterministic boundary disagreed near midnight and across
--      NZ DST transitions.
--   4. statement_lines.running_balance was clamped per line (greatest(0, …)), so an
--      overpaying account produced lines that don't foot to opening + Σ amounts.
--
-- The rework: ONE derivation. Per-invoice outstanding (signed, unclamped) is the source
-- of truth; positive outstanding ages into buckets (now with a real 61–90 band), negative
-- outstanding accumulates into credit_cents, and closing_balance := Σ buckets − credit.
-- The activity identity (opening + charges − payments = closing) becomes an algebraic
-- consequence — the function ASSERTS it and refuses to emit a statement that doesn't
-- reconcile. Balances may now legitimately be negative (customer in credit), so the ≥ 0
-- checks on opening/closing/running move out of the schema.
--
-- Day counting is calendar-day in a named timezone (default Pacific/Auckland): the date
-- an invoice becomes "31 days overdue" is a fact about NZ calendars, not about elapsed
-- 86400-second windows in UTC. overdue_days() is extracted as a function so the TS
-- mirror can be parity-tested against it in CI.
--
-- Historical statements keep their frozen numbers (snapshots are immutable by design);
-- new columns default to 0 for them.

-- ---------- schema ----------

alter table statements add column aging_90_cents bigint not null default 0
  check (aging_90_cents >= 0);
alter table statements add column credit_cents bigint not null default 0
  check (credit_cents >= 0);

comment on column statements.aging_90_cents is
  '61-90 days overdue. aging_90_plus_cents is now genuinely >90 days.';
comment on column statements.credit_cents is
  'Sum of overpaid-invoice credit at as_of. closing_balance = Σ aging buckets − credit.';

-- Balances can be negative (customer in credit) — drop the ≥0 checks. Gross activity
-- sums (charges/payments) and the aging buckets remain non-negative by construction.
alter table statements drop constraint statements_opening_balance_cents_check;
alter table statements drop constraint statements_closing_balance_cents_check;
alter table statement_lines drop constraint statement_lines_running_balance_cents_check;

-- ---------- overdue_days ----------
-- Calendar days between two instants, in the given timezone. DST-immune: subtracting
-- local dates counts calendar boundaries, not 24-hour windows. stable (not immutable)
-- because named-timezone conversion depends on the tz database.

create function overdue_days(
  p_anchor timestamptz,
  p_as_of  timestamptz,
  p_tz     text default 'Pacific/Auckland'
) returns integer
language sql
stable
security invoker
set search_path = pg_catalog, public
as $$
  select ((p_as_of at time zone p_tz)::date - (p_anchor at time zone p_tz)::date);
$$;

-- ---------- age_bucket: real 61–90 band ----------

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
  elsif p_overdue_days <= 90 then
    return '90';
  else
    return '90_plus';
  end if;
end $$;

-- ---------- generate_statement_atomic: single reconciled derivation ----------
-- Signature gains p_timezone, so the old function is dropped (create-or-replace would
-- otherwise leave both overloads live).

drop function generate_statement_atomic(uuid, uuid, timestamptz, timestamptz, text);

create function generate_statement_atomic(
  p_org_id            uuid,
  p_account_id        uuid,
  p_period_start_at   timestamptz,
  p_as_of_at          timestamptz,
  p_generated_by      text default 'controller',
  p_timezone          text default 'Pacific/Auckland'
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
  v_aging_90             bigint := 0;
  v_aging_90_plus        bigint := 0;
  v_credit               bigint := 0;
  v_statement_id         uuid;
  v_sort                 integer := 1;
  v_inv                  record;
  v_running              bigint := 0;
begin
  if p_org_id is null or p_account_id is null then
    raise exception 'generate_statement_atomic: org/account required';
  end if;
  if p_period_start_at is null or p_as_of_at is null or p_period_start_at > p_as_of_at then
    raise exception 'generate_statement_atomic: invalid period';
  end if;

  select currency into v_currency from accounts
    where id = p_account_id and org_id = p_org_id;
  if v_currency is null then
    raise exception 'generate_statement_atomic: account % not found in org %',
      p_account_id, p_org_id;
  end if;

  -- Opening balance: signed AR at period_start (no clamping — credit carries through).
  select coalesce(sum(i.total_cents - coalesce(p.paid, 0)), 0)
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

  -- Payments in period. The invoice filter mirrors the outstanding-side filter exactly
  -- (issued, non-void) so the activity identity below holds algebraically.
  select coalesce(sum(p.amount_cents), 0) into v_payments
    from payments p
    join invoices i on i.id = p.invoice_id and i.org_id = p_org_id
   where p.org_id = p_org_id
     and i.account_id = p_account_id
     and i.state <> 'void'
     and i.issued_at is not null
     and i.issued_at < p_as_of_at
     and p.received_at >= p_period_start_at
     and p.received_at <  p_as_of_at;

  -- THE derivation: per-invoice signed outstanding at as_of. Positive ages into a
  -- bucket; negative (overpaid) accumulates as credit.
  for v_inv in
    select i.total_cents,
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
    begin
      if v_outstanding = 0 then
        continue;
      elsif v_outstanding < 0 then
        v_credit := v_credit - v_outstanding;
      else
        case age_bucket(overdue_days(v_inv.age_anchor, p_as_of_at, p_timezone))
          when 'current' then v_aging_current := v_aging_current + v_outstanding;
          when '30'      then v_aging_30      := v_aging_30      + v_outstanding;
          when '60'      then v_aging_60      := v_aging_60      + v_outstanding;
          when '90'      then v_aging_90      := v_aging_90      + v_outstanding;
          else                v_aging_90_plus := v_aging_90_plus + v_outstanding;
        end case;
      end if;
    end;
  end loop;

  v_closing_balance := (v_aging_current + v_aging_30 + v_aging_60 + v_aging_90
                        + v_aging_90_plus) - v_credit;

  -- Reconciliation: with one derivation and mirrored filters this is an algebraic
  -- identity. If it ever trips, the data (or a future edit) broke the model — refuse
  -- to emit the statement rather than send a customer numbers that don't foot.
  if v_opening_balance + v_charges - v_payments <> v_closing_balance then
    raise exception
      'generate_statement_atomic: reconciliation failed for account % — opening % + charges % - payments % <> closing % (buckets - credit)',
      p_account_id, v_opening_balance, v_charges, v_payments, v_closing_balance;
  end if;

  insert into statements (
    org_id, account_id, currency, period_start_at, as_of_at,
    opening_balance_cents, charges_cents, payments_cents, closing_balance_cents,
    aging_current_cents, aging_30_cents, aging_60_cents, aging_90_cents,
    aging_90_plus_cents, credit_cents,
    generated_at, generated_by_agent
  ) values (
    p_org_id, p_account_id, v_currency, p_period_start_at, p_as_of_at,
    v_opening_balance, v_charges, v_payments, v_closing_balance,
    v_aging_current, v_aging_30, v_aging_60, v_aging_90,
    v_aging_90_plus, v_credit,
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

  -- Invoice + payment lines, interleaved by occurred_at. Running balance is unclamped —
  -- lines must foot: opening + Σ amounts = closing.
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
       and i.state <> 'void'
       and i.issued_at is not null
       and i.issued_at < p_as_of_at
       and p.received_at >= p_period_start_at
       and p.received_at <  p_as_of_at
    order by occurred_at, kind
  loop
    v_running := v_running + v_inv.amount;
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

  -- Closing line. The running balance must have arrived exactly at closing.
  if v_running <> v_closing_balance then
    raise exception
      'generate_statement_atomic: lines do not foot for account % — running % <> closing %',
      p_account_id, v_running, v_closing_balance;
  end if;
  insert into statement_lines (
    org_id, statement_id, line_type, sort_order, occurred_at,
    description, amount_cents, running_balance_cents
  ) values (
    p_org_id, v_statement_id, 'closing', v_sort, p_as_of_at,
    'Closing balance', v_closing_balance, v_closing_balance
  );

  return query select v_statement_id, v_closing_balance, v_sort;
end $$;
