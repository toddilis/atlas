#!/usr/bin/env bash
# Real separate PostgreSQL sessions, using ONLY the disposable migrated test DB.
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to the disposable verification database}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
sql() { psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 "$@"; }
sql -f - <<'SQL' >/dev/null
insert into orgs(id,slug,display_name) values ('10000000-0000-4000-8000-000000000003','dispatch-race','Synthetic race');
insert into dispatch_sources(id,org_id,provider,connection_key) values
  ('20000000-0000-4000-8000-000000000003','10000000-0000-4000-8000-000000000003','fixture','race');
select project_dispatch('10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003',
  x.key,x.ord,'2026-09-01T00:00:00Z','succeeded',null,
  jsonb_build_array(jsonb_build_object('source_line_key','1','order_line_key','1','item_key','SKU',
    'quantity',x.qty,'ordered_quantity',x.bound)),null,'{}')
from (values ('race-a','race-order',60,100),('race-b','race-order',60,100),
  ('same','same-order',10,10),('crash','crash-order',10,10)) x(key,ord,qty,bound);
SQL

claim_sql() {
  printf "select claim_dispatch('10000000-0000-4000-8000-000000000003','20000000-0000-4000-8000-000000000003',(select id from dispatches where source_id='20000000-0000-4000-8000-000000000003' and source_dispatch_key='%s'),'2026-09-01T00:00:00Z','%s');" "$1" "$2"
}
sql -c "BEGIN; $(claim_sql race-a race-a) SELECT pg_sleep(0.3); COMMIT;" >"$WORK/a" 2>&1 & a=$!
sql -c "BEGIN; $(claim_sql race-b race-b) SELECT pg_sleep(0.3); COMMIT;" >"$WORK/b" 2>&1 & b=$!
ra=0; rb=0
wait "$a" || ra=$?
wait "$b" || rb=$?
if ! { [[ "$ra" = 0 && "$rb" != 0 ]] || [[ "$ra" != 0 && "$rb" = 0 ]]; }; then
  cat "$WORK/a" "$WORK/b"; echo 'expected exactly one racing claim to succeed' >&2; exit 1
fi
grep -q 'exceeds original order line quantity' "$WORK/a" "$WORK/b"
[[ "$(sql -c "select count(*)||':'||sum(a.quantity) from dispatch_allocations a join dispatches d on d.id=a.dispatch_id where d.order_key='race-order';")" = '1:60' ]]

sql -c "BEGIN; $(claim_sql same same-key) SELECT pg_sleep(0.3); COMMIT;" >"$WORK/same-a" 2>&1 & a=$!
sql -c "BEGIN; $(claim_sql same same-key) SELECT pg_sleep(0.3); COMMIT;" >"$WORK/same-b" 2>&1 & b=$!
wait "$a"; wait "$b"
[[ "$(sql -c "select count(*) from dispatch_invoice_parts p join dispatches d on d.id=p.dispatch_id where d.order_key='same-order';")" = '1' ]]

# Terminate after claim has executed but before its owning transaction commits.
PGAPPNAME=atlas_dispatch_crash psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 \
  -c "BEGIN; $(claim_sql crash crash-key)" -c 'SELECT pg_sleep(30)' -c COMMIT >"$WORK/crash" 2>&1 & crashed=$!
backend=''
for _ in $(seq 1 50); do
  backend="$(sql -c "select pid from pg_stat_activity where application_name='atlas_dispatch_crash' and state='active' and query='SELECT pg_sleep(30)';")"
  [[ -n "$backend" ]] && break
  sleep 0.1
done
[[ "$backend" =~ ^[0-9]+$ ]] || { echo 'crash fixture did not reach pre-commit barrier' >&2; exit 1; }
sql -c "select pg_terminate_backend($backend);" >/dev/null
if wait "$crashed"; then echo 'terminated connection unexpectedly succeeded' >&2; exit 1; fi
[[ "$(sql -c "select count(*) from dispatch_invoice_parts p join dispatches d on d.id=p.dispatch_id where d.order_key='crash-order';")" = '0' ]]
sql -c "$(claim_sql crash crash-key)" >/dev/null
[[ "$(sql -c "select count(*)||':'||sum(a.quantity) from dispatch_allocations a join dispatches d on d.id=a.dispatch_id where d.order_key='crash-order';")" = '1:10' ]]
echo 'OK - concurrent order bounds, identical concurrent retries and terminated-transaction recovery'
