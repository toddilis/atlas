#!/usr/bin/env bash
# BILL-01 drafting races in real separate PostgreSQL sessions, using ONLY the disposable
# migrated test DB. Each case has its own synthetic business from pricing-fixtures.ts.
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to the disposable verification database}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
sql() { psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 "$@"; }

setup() {   # $1 = id prefix: org, active v1 pricing and the 40/60 dispatches of order-100
  npx tsx "$SCRIPT_DIR/pricing-fixtures.ts" "$1" >"$WORK/fixtures-$1.sql"
  sql -f "$WORK/fixtures-$1.sql" -f - <<'SQL' >/dev/null
do $$
declare company uuid:=current_setting('test.pricing_company'); source uuid; v uuid; revision timestamptz:='2026-10-02T09:00:00+13:00';
begin
  insert into orgs(id,slug,display_name) values(company,'bill-race-'||left(company::text,2),'Synthetic BILL race');
  insert into accounts(id,org_id,name) values(current_setting('test.pricing_account')::uuid,company,'Synthetic retailer');
  insert into products(id,org_id,sku,display_name) values(current_setting('test.pricing_product')::uuid,company,'WIDGET','Synthetic widget');
  v:=save_pricing_version(company,0,current_setting('test.pricing_config')::jsonb,'fixture-operator','Synthetic race version');
  perform activate_pricing_version(company,v,1,'fixture-operator','Synthetic race activation');
  insert into dispatch_sources(org_id,provider,connection_key) values(company,'synthetic','race') returning id into source;
  perform project_dispatch(company,source,'dispatch-a','order-100',revision,'succeeded',null,
    '[{"source_line_key":"original","order_line_key":"order-line","item_key":"WIDGET","quantity":40,"ordered_quantity":100}]',null,'{}',revision);
  perform project_dispatch(company,source,'dispatch-b','order-100',revision,'succeeded',null,
    '[{"source_line_key":"original","order_line_key":"order-line","item_key":"WIDGET","quantity":60,"ordered_quantity":100}]',null,'{}',revision);
end $$;
SQL
}

session() {  # $1 prefix, $2 fixture (a|b), $3 dispatch key, $4 seconds held open after drafting
  cat "$WORK/fixtures-$1.sql"
  cat <<SQL
select d.org_id company, d.source_id source, d.id dispatch, d.source_revision revision, v.version_id version,
  jsonb_set(jsonb_set(current_setting('test.pricing_$2')::jsonb,'{lines,0,lineId}',to_jsonb(l.id::text)),'{input,lines,0,lineId}',to_jsonb(l.id::text)) snapshot
from dispatches d join dispatch_lines l on l.dispatch_id=d.id join pricing_activations v on v.org_id=d.org_id
where d.org_id=current_setting('test.pricing_company')::uuid and d.source_dispatch_key='$3' \gset
begin;
set local role service_role;
select draft_dispatch_invoice(:'company',:'source',:'dispatch',:'revision',:'version',:'snapshot','#synthetic-100');
select pg_sleep($4);
commit;
SQL
}
count() { sql -c "select count(*) from $1 where org_id='$2000000-0000-4000-8000-000000000001'"; }

# Parts A and B drafted at the same moment: one shared order number, distinct suffixes,
# each dispatch billed at its own quantity and freight allocation.
setup 64
session 64 a dispatch-a 0.3 | sql -f - >"$WORK/ab-a" 2>&1 & a=$!
session 64 b dispatch-b 0.3 | sql -f - >"$WORK/ab-b" 2>&1 & b=$!
wait "$a" || { cat "$WORK/ab-a"; exit 1; }
wait "$b" || { cat "$WORK/ab-b"; exit 1; }
[[ "$(sql -c "select count(*)||':'||string_agg(right(invoice_number,1),'' order by invoice_number)||':'||count(distinct left(invoice_number,-1)) from invoices where org_id='64000000-0000-4000-8000-000000000001'")" = '2:AB:1' ]] \
  || { echo 'concurrent A/B drafts did not produce one order number with suffixes A and B' >&2; exit 1; }
[[ "$(sql -c "select string_agg(d.source_dispatch_key||'='||l.quantity||'/'||i.total_cents,',' order by d.source_dispatch_key) from invoice_calculation_snapshots s join invoices i on i.id=s.invoice_id join dispatches d on d.id=s.dispatch_id join dispatch_allocations l on l.part_id=s.part_id where s.org_id='64000000-0000-4000-8000-000000000001'")" = 'dispatch-a=40/37260,dispatch-b=60/55890' ]] \
  || { echo 'concurrent A/B drafts billed the wrong quantity or amount' >&2; exit 1; }
[[ "$(count platform_events 64)" = 2 ]] || { echo 'expected one drafted event per part' >&2; exit 1; }

# The same dispatch drafted twice at once: one part, one invoice, one event; the loser
# waits for the winner's commit and returns the stored part.
setup 65
session 65 a dispatch-a 0.3 | sql -f - >"$WORK/same-1" 2>&1 & a=$!
session 65 a dispatch-a 0.3 | sql -f - >"$WORK/same-2" 2>&1 & b=$!
wait "$a" || { cat "$WORK/same-1"; exit 1; }
wait "$b" || { cat "$WORK/same-2"; exit 1; }
[[ "$(cat "$WORK/same-1" "$WORK/same-2" | grep -c '"reused": false')" = 1 && "$(cat "$WORK/same-1" "$WORK/same-2" | grep -c '"reused": true')" = 1 ]] \
  || { cat "$WORK/same-1" "$WORK/same-2"; echo 'expected one new and one reused draft' >&2; exit 1; }
[[ "$(grep -ho '"invoiceId": "[^"]*"' "$WORK/same-1" "$WORK/same-2" | sort -u | wc -l)" = 1 ]] || { echo 'racing drafts returned different invoices' >&2; exit 1; }
[[ "$(count invoices 65):$(count dispatch_invoice_parts 65):$(count platform_events 65)" = '1:1:1' ]] \
  || { echo 'same-dispatch race created more than one effect' >&2; exit 1; }

# A drafting session killed before commit leaves nothing; the next draft of that dispatch
# succeeds normally and takes the next suffix.
session 65 b dispatch-b 30 | PGAPPNAME=atlas_bill_crash sql -f - >"$WORK/crash" 2>&1 & crashed=$!
backend=''
for _ in $(seq 1 100); do
  backend="$(sql -c "select pid from pg_stat_activity where application_name='atlas_bill_crash' and state='active' and query like 'select pg_sleep(30)%'")"
  [[ -n "$backend" ]] && break
  sleep 0.1
done
[[ "$backend" =~ ^[0-9]+$ ]] || { cat "$WORK/crash"; echo 'crash fixture did not reach its pre-commit barrier' >&2; exit 1; }
sql -c "select pg_terminate_backend($backend)" >/dev/null
if wait "$crashed"; then echo 'terminated draft unexpectedly committed' >&2; exit 1; fi
[[ "$(count invoices 65):$(count dispatch_invoice_parts 65):$(count platform_events 65)" = '1:1:1' ]] \
  || { echo 'terminated draft left an effect' >&2; exit 1; }
session 65 b dispatch-b 0 | sql -f - >"$WORK/recovered" 2>&1 || { cat "$WORK/recovered"; exit 1; }
grep -q '"reused": false' "$WORK/recovered"
[[ "$(sql -c "select right(invoice_number,1)||':'||total_cents from invoices i join invoice_calculation_snapshots s on s.invoice_id=i.id join dispatches d on d.id=s.dispatch_id where i.org_id='65000000-0000-4000-8000-000000000001' and d.source_dispatch_key='dispatch-b'")" = 'B:55890' ]] \
  || { echo 'recovered draft did not become part B' >&2; exit 1; }
echo 'OK - concurrent A/B parts, identical concurrent drafts and terminated-draft recovery'
