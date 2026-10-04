#!/usr/bin/env bash
# Disposable CI database only. Two distinct approvals compete for ONE allowance.
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to a fresh disposable verification database}"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
sql() { psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 "$@"; }
for policy in rollingWindow velocityLimit; do
  if [[ "$policy" = rollingWindow ]]; then config='{"rollingWindow":{"amount":"1000","windowHours":24}}';
  else config='{"velocityLimit":{"maxActions":1,"windowHours":24}}'; fi
  org="$(sql -c "insert into orgs(slug,display_name) values('policy-race-'||gen_random_uuid(),'Synthetic policy race') returning id;")"
  sql -c "select seed_chart_of_accounts('$org');
    insert into tool_grants(org_id,agent_name,tool_name,risk) values('$org','controller','controller.issue_invoice','approve_required');
    insert into policy_rules(org_id,scope_action,config) values('$org','controller.issue_invoice','$config');" >/dev/null
  for n in 1 2; do
    sql >"$work/claim$n" <<SQL
with invoice as (
 insert into invoices(org_id,invoice_number,currency,subtotal_cents,total_cents,state,channel)
 values('$org','race-$n','NZD',1000,1000,'draft','wholesale') returning id
)
select id from invoice;
SQL
    invoice="$(cat "$work/claim$n")"
    approval="$(sql -c "select create_bound_approval('$org',jsonb_build_object(
      'schema_version',1,'org_id','$org','agent_name','controller','tool_name','controller.issue_invoice',
      'subject_type','invoice','subject_id','$invoice','subject_snapshot',invoice_action_snapshot('$org','$invoice'),
      'policy_snapshot',current_action_policy('$org','controller.issue_invoice'),
      'input',jsonb_build_object('invoiceId','$invoice','amount',jsonb_build_object('\$atlas_bigint','1000'),
      'currency','NZD','accountId',null,'fulfillmentEventId',null)),now()+interval '1 hour');")"
    sql -c "select decide_bound_approval('$org','$approval','approved','synthetic-operator');" >/dev/null
    claim="$(sql -c "select claim_bound_action('$org','$approval','synthetic-worker',
      current_action_policy('$org','controller.issue_invoice'),invoice_action_snapshot('$org','$invoice'));")"
    # JSON extraction stays in Postgres; do not rely on jq being installed.
    action="$(sql -c "select '$claim'::jsonb->>'action_id';")"
    attempt="$(sql -c "select '$claim'::jsonb->>'execution_id';")"
    printf "begin; select issue_bound_invoice('%s','%s','%s'); select pg_sleep(0.3); commit;\n" "$org" "$action" "$attempt" >"$work/issue$n.sql"
  done
  sql -f "$work/issue1.sql" >"$work/a" 2>&1 & a=$!
  sql -f "$work/issue2.sql" >"$work/b" 2>&1 & b=$!
  ra=0; rb=0
  wait "$a" || ra=$?
  wait "$b" || rb=$?
  if ! { [[ "$ra" = 0 && "$rb" != 0 ]] || [[ "$ra" != 0 && "$rb" = 0 ]]; }; then
    cat "$work/a" "$work/b"; echo 'expected exactly one distinct invoice effect' >&2; exit 1
  fi
  grep -Eq 'current policy (rolling-window cap|velocity limit) blocks action' "$work/a" "$work/b"
  [[ "$(sql -c "select count(*) from invoices where org_id='$org' and state='issued';")" = 1 ]]
  [[ "$(sql -c "select count(*) from ledger_transactions where org_id='$org' and source='invoice_issued';")" = 1 ]]
  [[ "$(sql -c "select count(*) from action_attempts where org_id='$org';")" = 2 ]]
  [[ "$(sql -c "select count(*) from outbox where org_id='$org' and state='failed';")" = 1 ]]
  echo "OK - $policy serializes distinct approved invoice effects; attempts survive rejection"
done
[[ "$(sql -c "select has_function_privilege('service_role','issue_invoice_atomic(uuid,uuid,text)','execute');")" = f ]]
echo 'OK - unbound service-role issuance is refused'

# An approval valid on entry may expire while waiting for the invoice row.
org="$(sql -c "insert into orgs(slug,display_name) values('expiry-wait-'||gen_random_uuid(),'Synthetic expiry wait') returning id;")"
sql -c "select seed_chart_of_accounts('$org'); insert into tool_grants(org_id,agent_name,tool_name,risk)
 values('$org','controller','controller.issue_invoice','approve_required');" >/dev/null
invoice="$(sql -c "insert into invoices(org_id,invoice_number,currency,subtotal_cents,total_cents,state,channel)
 values('$org','expiry-wait','NZD',1000,1000,'draft','wholesale') returning id;")"
approval="$(sql -c "select create_bound_approval('$org',jsonb_build_object(
 'schema_version',1,'org_id','$org','agent_name','controller','tool_name','controller.issue_invoice',
 'subject_type','invoice','subject_id','$invoice','subject_snapshot',invoice_action_snapshot('$org','$invoice'),'policy_snapshot',null,
 'input',jsonb_build_object('invoiceId','$invoice','amount',jsonb_build_object('\$atlas_bigint','1000'),
 'currency','NZD','accountId',null,'fulfillmentEventId',null)),clock_timestamp()+interval '3 seconds');")"
sql -c "select decide_bound_approval('$org','$approval','approved','synthetic-operator');" >/dev/null
claim="$(sql -c "select claim_bound_action('$org','$approval','synthetic-worker','null',invoice_action_snapshot('$org','$invoice'));")"
action="$(sql -c "select '$claim'::jsonb->>'action_id';")"
attempt="$(sql -c "select '$claim'::jsonb->>'execution_id';")"
sql >"$work/locker" 2>&1 <<SQL &
begin;
select id from invoices where id='$invoice' for update;
\echo LOCKED
select pg_sleep(4);
commit;
SQL
locker=$!
for n in $(seq 1 50); do
  grep -q LOCKED "$work/locker" && break
  sleep 0.02
done
grep -q LOCKED "$work/locker"
if sql -c "select issue_bound_invoice('$org','$action','$attempt');" >"$work/expired" 2>&1; then
  echo 'expired approval issued after lock wait' >&2; exit 1
fi
wait "$locker"
grep -q 'approval expired before invoice effect' "$work/expired"
[[ "$(sql -c "select state from invoices where id='$invoice';")" = draft ]]
[[ "$(sql -c "select count(*) from outbox where org_id='$org';")" = 0 ]]
[[ "$(sql -c "select count(*) from ledger_transactions where org_id='$org';")" = 0 ]]
sql -c "select finish_bound_action('$org','$action','$attempt','FAILED','null',
 '{\"source\":\"issue_bound_invoice\",\"sqlstate\":\"P0001\",\"reason\":\"approval expired before invoice effect\"}',
 'approval expired before invoice effect');" >/dev/null
[[ "$(sql -c "select state from action_attempts where id='$attempt';")" = FAILED ]]
echo 'OK - actual expiry during invoice lock wait refuses every effect and retains failed attempt'
