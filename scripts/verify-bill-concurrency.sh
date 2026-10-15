#!/usr/bin/env bash
# BILL-01 drafting races in real separate PostgreSQL sessions, using ONLY the disposable
# migrated test DB. Each case has its own synthetic business from pricing-fixtures.ts.
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to the disposable verification database}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
sql() { psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 "$@"; }

setup() {   # $1 = id prefix: Shopify order 100 for its retailer, active v1 pricing, the 40/60
            # dispatches and a stored carrier quote for each, since either may be drafted first
  npx tsx "$SCRIPT_DIR/pricing-fixtures.ts" "$1" >"$WORK/fixtures-$1.sql"
  sql -f "$WORK/fixtures-$1.sql" -f - <<'SQL' >/dev/null
do $$
declare company uuid:=current_setting('test.pricing_company'); account uuid:=current_setting('test.pricing_account');
  order100 uuid:=current_setting('test.pricing_order_100'); source uuid; v uuid; d uuid; q jsonb; f text;
  revision timestamptz:='2026-10-02T09:00:00+13:00';
begin
  insert into orgs(id,slug,display_name) values(company,'bill-race-'||left(company::text,2),'Synthetic BILL race');
  insert into accounts(id,org_id,name) values(account,company,'Synthetic retailer');
  insert into products(id,org_id,sku,display_name) values(current_setting('test.pricing_product')::uuid,company,'WIDGET','Synthetic widget');
  insert into shopify_customers(org_id,shopify_customer_id,raw,account_id) values(company,'cust-a','{}',account);
  insert into shopify_orders(id,org_id,shopify_order_id,shopify_customer_id,currency,subtotal_cents,total_cents,raw,placed_at)
    values(order100,company,'100','cust-a','NZD',0,0,'{}','2026-10-01T09:00:00+13:00');
  v:=save_pricing_version(company,0,current_setting('test.pricing_config')::jsonb,'fixture-operator','Synthetic race version');
  perform activate_pricing_version(company,v,1,'fixture-operator','Synthetic race activation');
  source:=bind_shopify_dispatch_source(company,left(company::text,2)||'-race.myshopify.com');
  foreach f in array array['a','b_first'] loop
    q:=current_setting('test.pricing_'||f)::jsonb#>'{input,carrier}';
    d:=project_dispatch(company,source,q->>'shipmentKey',order100::text,revision,'succeeded',null,
      jsonb_build_array(jsonb_build_object('source_line_key','original','order_line_key','order-line','item_key','WIDGET',
        'quantity',current_setting('test.pricing_'||f)::jsonb#>'{lines,0,dispatched}','ordered_quantity',100)),null,'{}',revision);
    perform record_carrier_cost(company,source,d,q->>'connectionId',q->>'quoteId',q->>'currency',(q->>'cost')::bigint,
      (q->>'observedAt')::timestamptz,(q->>'expiresAt')::timestamptz,'{"synthetic":true}');
  end loop;
end $$;
SQL
}

session() {  # $1 prefix, $2 fixture, $3 dispatch key, $4 seconds held open after drafting
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
parts() { sql -c "select string_agg(d.source_dispatch_key||'='||right(i.invoice_number,1)||'/'||l.quantity||'/'||(s.snapshot#>>'{freight,amount}')||'/'||i.total_cents,',' order by d.source_dispatch_key)
  from invoice_calculation_snapshots s join invoices i on i.id=s.invoice_id join dispatches d on d.id=s.dispatch_id
  join dispatch_allocations l on l.part_id=s.part_id where s.org_id='$1000000-0000-4000-8000-000000000001'"; }

# A and B drafted at the same moment, each claiming to be the order's first part. The order
# lock admits one; the other is refused as stale and redrafted as a later, freight-free part.
setup 64
session 64 a dispatch-a 0.3 | sql -f - >"$WORK/ab-a" 2>&1 & a=$!
session 64 b_first dispatch-b 0.3 | sql -f - >"$WORK/ab-b" 2>&1 & b=$!
ra=0; rb=0; wait "$a" || ra=$?; wait "$b" || rb=$?
if [[ "$ra" = 0 && "$rb" != 0 ]]; then loser="$WORK/ab-b"; retry='b dispatch-b'; expected='dispatch-a=A/40/1000/37950,dispatch-b=B/60/0/55200'
elif [[ "$ra" != 0 && "$rb" = 0 ]]; then loser="$WORK/ab-a"; retry='a_later dispatch-a'; expected='dispatch-a=B/40/0/36800,dispatch-b=A/60/1000/56350'
else cat "$WORK/ab-a" "$WORK/ab-b"; echo 'expected exactly one concurrent first part' >&2; exit 1; fi
grep -q 'stale part order' "$loser" || { cat "$loser"; echo 'the losing first part failed for another reason' >&2; exit 1; }
# shellcheck disable=SC2086
session 64 $retry 0 | sql -f - >"$WORK/ab-retry" 2>&1 || { cat "$WORK/ab-retry"; echo 'redrafting the later part failed' >&2; exit 1; }
[[ "$(parts 64)" = "$expected" ]] || { parts 64; echo "concurrent A/B parts differ from $expected" >&2; exit 1; }
[[ "$(sql -c "select count(distinct left(invoice_number,-1)) from invoices where org_id='64000000-0000-4000-8000-000000000001'")" = 1 ]] \
  || { echo 'A/B parts do not share one order number' >&2; exit 1; }
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
[[ "$(parts 65)" = 'dispatch-a=A/40/1000/37950,dispatch-b=B/60/0/55200' ]] || { parts 65; echo 'recovered draft did not become part B' >&2; exit 1; }
echo 'OK - one concurrent first part, identical concurrent drafts and terminated-draft recovery'
