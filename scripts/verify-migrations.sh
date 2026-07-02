#!/usr/bin/env bash
# verify-migrations.sh — apply every migration in order against a real Postgres and smoke-
# test the invariants that only exist at the SQL layer: triggers, unique indexes, and the
# PL/pgSQL that CI-mocked unit tests never execute. This is the repeatable artifact behind
# the 0016 post-mortem lesson ("the RPC was never actually invoked in CI"). PR-M wires it
# into CI; until then it runs locally.
#
# Usage:
#   DATABASE_URL=postgres://…  scripts/verify-migrations.sh    # use an existing server
#   scripts/verify-migrations.sh                               # spin an ephemeral cluster
#
# The ephemeral path needs PostgreSQL server binaries (initdb/pg_ctl) and the pgvector
# extension package (0008 requires it). When run as root, cluster commands are executed as
# the `postgres` system user.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MIG_DIR="$SCRIPT_DIR/../supabase/migrations"

# ---------- connection plumbing ----------

WORK=""
PGPORT=5499

pg_user_exec() {                                   # run a command as the cluster owner
  if [[ $(id -u) -eq 0 ]]; then
    su -s /bin/bash postgres -c "PATH=\"$PATH\"; $1"   # su resets PATH; carry ours through
  else
    bash -c "$1"
  fi
}

psql_run() {                                       # psql with fail-fast, args passed through
  if [[ -n "${DATABASE_URL:-}" ]]; then
    psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"
  else
    pg_user_exec "psql 'host=$WORK/sock port=$PGPORT dbname=atlas_verify user=postgres' -X -q -v ON_ERROR_STOP=1 $(printf '%q ' "$@")"
  fi
}

cleanup() {
  if [[ -n "$WORK" ]]; then
    pg_user_exec "pg_ctl -D '$WORK/data' -m immediate stop" >/dev/null 2>&1 || true
    rm -rf "$WORK"
  fi
}
trap cleanup EXIT

if [[ -z "${DATABASE_URL:-}" ]]; then
  PG_BIN="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [[ -n "$PG_BIN" ]] && export PATH="$PG_BIN:$PATH"
  command -v initdb >/dev/null || { echo "initdb not found — install postgresql or set DATABASE_URL" >&2; exit 1; }

  WORK="$(mktemp -d)"
  mkdir -p "$WORK/sock"
  [[ $(id -u) -eq 0 ]] && chown -R postgres:postgres "$WORK"
  pg_user_exec "initdb -D '$WORK/data' -A trust" >/dev/null
  pg_user_exec "pg_ctl -D '$WORK/data' -o \"-p $PGPORT -k '$WORK/sock' -c listen_addresses=''\" -w -l '$WORK/pg.log' start" >/dev/null
  pg_user_exec "createdb -h '$WORK/sock' -p $PGPORT -U postgres atlas_verify"
  echo "ephemeral cluster up (socket $WORK/sock)"
fi

# ---------- apply migrations in order ----------

shopt -s nullglob
count=0
for f in "$MIG_DIR"/*.sql; do
  base="$(basename "$f")"

  # Just before 0017 lands, seed one spine event so the migration's backfill (history →
  # 'projected') is exercised, not just its empty-table no-op path.
  if [[ "$base" == 0017_* ]]; then
    psql_run -c "insert into orgs (slug, display_name) values ('verify', 'Verify Org') on conflict do nothing;"
    psql_run -c "insert into event_log (org_id, type, source, payload, idempotency_key)
                 select id, 'system.org.bootstrapped', 'verify', '{}'::jsonb, 'verify.pre0017'
                 from orgs where slug = 'verify';"
  fi

  psql_run -f "$f" >/dev/null
  echo "applied  $base"
  count=$((count + 1))
done
[[ $count -gt 0 ]] || { echo "no migrations found in $MIG_DIR" >&2; exit 1; }

# ---------- smoke assertions ----------

psql_run -f - <<'SQL' >/dev/null
-- Fixture org (created pre-0017 above; idempotent for the DATABASE_URL path).
insert into orgs (slug, display_name) values ('verify', 'Verify Org') on conflict do nothing;

-- 1 · seed_chart_of_accounts is callable and populates the chart.
do $$
declare v_org uuid; v_n int;
begin
  select id into v_org from orgs where slug = 'verify';
  perform seed_chart_of_accounts(v_org);
  select count(*) into v_n from ledger_accounts where org_id = v_org;
  if v_n < 1 then raise exception 'ASSERT seed_chart: no ledger accounts seeded'; end if;
end $$;

-- 2 · 0017 trigger: a fresh append gets a same-transaction 'pending' projection row.
do $$
declare v_org uuid; v_event uuid; v_state text;
begin
  select id into v_org from orgs where slug = 'verify';
  insert into event_log (org_id, type, source, payload, idempotency_key)
    values (v_org, 'system.org.bootstrapped', 'verify', '{}'::jsonb, 'verify.post0017')
    returning id into v_event;
  select state::text into v_state from event_projections where event_id = v_event;
  if v_state is distinct from 'pending' then
    raise exception 'ASSERT 0017 trigger: expected pending, got %', coalesce(v_state, '<missing>');
  end if;
end $$;

-- 3 · 0017 backfill: the pre-0017 event was marked 'projected', not left outstanding.
do $$
declare v_state text;
begin
  select ep.state::text into v_state
    from event_projections ep
    join event_log e on e.id = ep.event_id
   where e.idempotency_key = 'verify.pre0017';
  if v_state is distinct from 'projected' then
    raise exception 'ASSERT 0017 backfill: expected projected, got %', coalesce(v_state, '<missing>');
  end if;
end $$;

-- 4 · event_log immutability triggers still hold after 0017.
do $$
begin
  begin
    update event_log set source = 'tamper' where idempotency_key = 'verify.post0017';
    raise exception 'ASSERT immutability: update was not blocked';
  exception when raise_exception then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;
end $$;

-- 5 · narrative dedup keys: duplicates rejected, null keys unconstrained.
do $$
declare v_org uuid;
begin
  select id into v_org from orgs where slug = 'verify';
  insert into agent_activity (org_id, agent_name, kind, summary, dedup_key)
    values (v_org, 'verify', 'note', 'once', 'verify.activity');
  begin
    insert into agent_activity (org_id, agent_name, kind, summary, dedup_key)
      values (v_org, 'verify', 'note', 'twice', 'verify.activity');
    raise exception 'ASSERT dedup: duplicate agent_activity.dedup_key accepted';
  exception when unique_violation then null;
  end;
  insert into agent_activity (org_id, agent_name, kind, summary) values (v_org, 'verify', 'note', 'x');
  insert into agent_activity (org_id, agent_name, kind, summary) values (v_org, 'verify', 'note', 'x');

  insert into observations (org_id, agent_name, kind, content, dedup_key)
    values (v_org, 'verify', 'fact', 'once', 'verify.observation');
  begin
    insert into observations (org_id, agent_name, kind, content, dedup_key)
      values (v_org, 'verify', 'fact', 'twice', 'verify.observation');
    raise exception 'ASSERT dedup: duplicate observations.dedup_key accepted';
  exception when unique_violation then null;
  end;
end $$;

-- 6 · deterministic money functions behave as documented.
do $$
begin
  if compute_gst_cents(10000, 1500) <> 1500 then raise exception 'ASSERT gst: 10000 @ 15%%'; end if;
  if compute_gst_cents(3, 1500) <> 0 then raise exception 'ASSERT gst: floor rounding'; end if;
end $$;

do $$
declare v_org uuid; n1 text; n2 text;
begin
  select id into v_org from orgs where slug = 'verify';
  n1 := next_invoice_number(v_org);
  n2 := next_invoice_number(v_org);
  if n1 <> 'ATL-0001' or n2 <> 'ATL-0002' then
    raise exception 'ASSERT invoice numbering: got %, %', n1, n2;
  end if;
end $$;

-- 7 · RPC execution probes — the 0016 bug class. Each financial RPC is invoked far enough
-- to execute its early statements (including draft_invoice_atomic's idempotency SELECT,
-- the exact site of the 42702 shipped in 0013). A business-rule raise (P0001) is the
-- expected outcome with synthetic ids; a parse/plan error (42702 ambiguous column, 42703
-- undefined column, …) propagates and fails this script. Full fixture-graph exercise of
-- the happy paths lands with PR-M.
do $$
declare v_org uuid;
begin
  select id into v_org from orgs where slug = 'verify';

  begin
    perform 1 from draft_invoice_atomic(
      v_org, gen_random_uuid(), gen_random_uuid(), 'NZD',
      '[{"quantity": "1", "unit_price_cents": "100", "description": "probe"}]'::jsonb);
    raise exception 'ASSERT rpc probe: draft_invoice_atomic accepted synthetic ids';
  exception when raise_exception then
    if sqlerrm like 'ASSERT%' then raise; end if;
  end;

  begin
    perform 1 from issue_invoice_atomic(v_org, gen_random_uuid(), 'verify.outbox.probe');
    raise exception 'ASSERT rpc probe: issue_invoice_atomic accepted synthetic ids';
  exception when raise_exception then
    if sqlerrm like 'ASSERT%' then raise; end if;
  end;

  begin
    perform 1 from post_payment_received(v_org, gen_random_uuid());
    raise exception 'ASSERT rpc probe: post_payment_received accepted synthetic ids';
  exception when raise_exception then
    if sqlerrm like 'ASSERT%' then raise; end if;
  end;

  begin
    perform 1 from generate_statement_atomic(
      v_org, gen_random_uuid(), now() - interval '30 days', now());
    raise exception 'ASSERT rpc probe: generate_statement_atomic accepted synthetic ids';
  exception when raise_exception then
    if sqlerrm like 'ASSERT%' then raise; end if;
  end;
end $$;

-- 8 · PR-K payment atomicity — full behavioural test. The whole mechanism lives in one
-- SQL transaction now, so this IS the acceptance test for "crash between payment insert
-- and posting → redelivery posts exactly once".
do $$
declare
  v_org        uuid;
  v_account    uuid;
  v_invoice    uuid;
  v_invoice2   uuid;
  v_stranded   uuid;
  r            record;
  v_count      int;
  v_posted     timestamptz;
  v_inv_state  invoice_state;
begin
  select id into v_org from orgs where slug = 'verify';
  insert into accounts (org_id, name) values (v_org, 'Verify Venue')
    returning id into v_account;
  insert into invoices (org_id, channel, account_id, invoice_number, state, currency,
                        subtotal_cents, tax_cents, total_cents, issued_at, stripe_invoice_id)
  values (v_org, 'wholesale', v_account, next_invoice_number(v_org), 'issued', 'NZD',
          10000, 1500, 11500, now(), 'in_verify_1')
  returning id into v_invoice;

  -- 8a · first delivery: posts once, transitions to paid, stamps posted_at, balances.
  select * into r from record_stripe_payment(
    v_org, 'in_verify_1', 'stripe_event:evt_verify_1', 11500, 'NZD', now(), '{}'::jsonb);
  if r.rsp_was_existing then raise exception 'ASSERT prk-8a: first call reported was_existing'; end if;
  if r.rsp_invoice_state <> 'paid' then
    raise exception 'ASSERT prk-8a: expected paid, got %', r.rsp_invoice_state;
  end if;
  select count(*) into v_count from ledger_transactions
   where org_id = v_org and source = 'payment_received' and source_ref = r.rsp_payment_id;
  if v_count <> 1 then raise exception 'ASSERT prk-8a: expected 1 posting, got %', v_count; end if;
  select posted_at into v_posted from payments where id = r.rsp_payment_id;
  if v_posted is null then raise exception 'ASSERT prk-8a: posted_at not stamped'; end if;
  perform 1
     from ledger_lines l
     join ledger_transactions t on t.id = l.transaction_id
    where t.source_ref = r.rsp_payment_id
   having sum(l.amount_cents) <> 0;
  if found then raise exception 'ASSERT prk-8a: posting does not balance'; end if;

  -- 8b · redelivery: adopted, and still exactly one posting (double-post regression).
  select * into r from record_stripe_payment(
    v_org, 'in_verify_1', 'stripe_event:evt_verify_1', 11500, 'NZD', now(), '{}'::jsonb);
  if not r.rsp_was_existing then raise exception 'ASSERT prk-8b: redelivery not adopted'; end if;
  select count(*) into v_count from ledger_transactions
   where org_id = v_org and source = 'payment_received' and source_ref = r.rsp_payment_id;
  if v_count <> 1 then raise exception 'ASSERT prk-8b: double post — % postings', v_count; end if;

  -- 8c · direct double-invocation of post_payment_received is a no-op now.
  perform 1 from post_payment_received(v_org, r.rsp_payment_id);
  select count(*) into v_count from ledger_transactions
   where org_id = v_org and source = 'payment_received' and source_ref = r.rsp_payment_id;
  if v_count <> 1 then raise exception 'ASSERT prk-8c: direct re-run double-posted'; end if;

  -- 8d · stranded pre-0018 payment (the crash window): row exists, posted_at null,
  -- invoice never transitioned. The redelivery completes the posting.
  insert into invoices (org_id, channel, account_id, invoice_number, state, currency,
                        subtotal_cents, tax_cents, total_cents, issued_at, stripe_invoice_id)
  values (v_org, 'wholesale', v_account, next_invoice_number(v_org), 'issued', 'NZD',
          5000, 750, 5750, now(), 'in_verify_2')
  returning id into v_invoice2;
  insert into payments (org_id, invoice_id, amount_cents, currency, method,
                        stripe_payment_id, received_at, raw)
  values (v_org, v_invoice2, 5750, 'NZD', 'stripe',
          'stripe_event:evt_verify_2', now(), '{}'::jsonb)
  returning id into v_stranded;

  select * into r from record_stripe_payment(
    v_org, 'in_verify_2', 'stripe_event:evt_verify_2', 5750, 'NZD', now(), '{}'::jsonb);
  if not r.rsp_was_existing then raise exception 'ASSERT prk-8d: stranded payment not adopted'; end if;
  if r.rsp_payment_id <> v_stranded then
    raise exception 'ASSERT prk-8d: adopted a different payment row';
  end if;
  select state into v_inv_state from invoices where id = v_invoice2;
  if v_inv_state <> 'paid' then
    raise exception 'ASSERT prk-8d: stranded payment not healed — invoice %', v_inv_state;
  end if;
  select count(*) into v_count from ledger_transactions
   where org_id = v_org and source = 'payment_received' and source_ref = v_stranded;
  if v_count <> 1 then raise exception 'ASSERT prk-8d: heal posted % times', v_count; end if;
  select posted_at into v_posted from payments where id = v_stranded;
  if v_posted is null then raise exception 'ASSERT prk-8d: heal did not stamp posted_at'; end if;
end $$;

-- 9 · PR-L control-plane integrity: audit_log immutability triggers + approval single-use.
do $$
declare v_org uuid; v_audit uuid; v_approval uuid; v_n int;
begin
  select id into v_org from orgs where slug = 'verify';

  -- 9a · audit_log rows can no longer be rewritten or deleted, even by the table owner.
  insert into audit_log (org_id, agent_name, action, risk, outcome)
    values (v_org, 'verify', 'probe', 'auto', 'success')
    returning id into v_audit;
  begin
    update audit_log set action = 'tampered' where id = v_audit;
    raise exception 'ASSERT prl-9a: audit_log update was not blocked';
  exception when raise_exception then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;
  begin
    delete from audit_log where id = v_audit;
    raise exception 'ASSERT prl-9a: audit_log delete was not blocked';
  exception when raise_exception then
    if sqlerrm not like '%append-only%' then raise; end if;
  end;

  -- 9b · approval single-use: the executed_at compare-and-swap admits exactly one winner.
  insert into approvals (org_id, agent_name, action, subject_type, payload, risk, state)
    values (v_org, 'verify', 'probe', 'invoice', '{}'::jsonb, 'approve_required', 'approved')
    returning id into v_approval;
  update approvals set executed_at = now()
   where id = v_approval and state = 'approved' and executed_at is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then raise exception 'ASSERT prl-9b: first consume affected % rows', v_n; end if;
  update approvals set executed_at = now()
   where id = v_approval and state = 'approved' and executed_at is null;
  get diagnostics v_n = row_count;
  if v_n <> 0 then raise exception 'ASSERT prl-9b: approval consumed twice'; end if;
end $$;
SQL

echo "OK — $count migrations applied clean; 0017 trigger/backfill, immutability, dedup keys, money functions, RPC execution probes, PR-K payment-atomicity behaviour (exactly-once posting, redelivery adoption, stranded-payment heal), and PR-L control-plane integrity (audit_log immutability, approval single-use CAS) all pass"
