#!/usr/bin/env bash
set -euo pipefail
: "${DATABASE_URL:?Disposable verification database required}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
sql() { psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 "$@"; }
org='50000000-0000-4000-8000-000000000001'
sql -c "insert into orgs(id,slug,display_name) values('$org','events-race','Synthetic events race');" >/dev/null
publish="select publish_platform_event('$org',jsonb_build_object('event_id','race','event_type','controller.invoice.drafted','event_version',1,'company_id','$org','connection_id',null,'occurred_at','2026-10-01T00:00:00Z','observed_at','2026-10-01T00:00:00Z','producer','fixture','subject_type','Invoice','subject_id','race','subject_version',1,'correlation_id','race','causation_id',null,'source_refs','[]'::jsonb,'evidence_refs','[]'::jsonb,'event_class','fact','payload','{\"value\":\"synthetic\"}'::jsonb),'same-source',array['race']);"
sql -c "begin; $publish select pg_sleep(0.3); commit;" >"$WORK/pub-a" 2>&1 & a=$!
sql -c "$publish" >"$WORK/pub-b" 2>&1 & b=$!
wait "$a"; wait "$b"
[[ "$(sql -c "select count(*) from platform_events where org_id='$org';")" = 1 ]]
claim="select claim_event_receipt('$org','race','live');"
sql -c "begin; $claim select pg_sleep(0.3); commit;" >"$WORK/a" 2>&1 & a=$!
sql -c "begin; $claim select pg_sleep(0.3); commit;" >"$WORK/b" 2>&1 & b=$!
wait "$a"; wait "$b"
[[ "$(sql -c "select attempts from event_receipts where org_id='$org';")" = 1 ]]
# Kill a real worker session after its claim committed. Its lease survives.
sql -c "update event_receipts set lease_until=now()-interval '1 second' where org_id='$org';" >/dev/null
sql -c "set application_name='atlas_event_crash_fixture'; $claim" -c "select pg_sleep(30);" >"$WORK/crash" 2>&1 & crashed=$!
for _ in $(seq 1 100); do
  [[ "$(sql -c "select attempts from event_receipts where org_id='$org';")" = 2 ]] && break
  sleep 0.05
done
[[ "$(sql -c "select attempts from event_receipts where org_id='$org';")" = 2 ]]
old_token="$(sql -c "select lease_token from event_receipts where org_id='$org';")"
sql -c "select pg_terminate_backend(pid) from pg_stat_activity where application_name='atlas_event_crash_fixture';" >/dev/null
wait "$crashed" && { echo 'worker did not terminate' >&2; exit 1; }
[[ "$(sql -c "$claim")" = '' ]]
sql -c "update event_receipts set lease_until=now()-interval '1 second' where org_id='$org'; $claim" >/dev/null
if sql -c "select apply_event_projection('$org','race','live','race','$old_token');" >"$WORK/stale" 2>&1; then echo 'stale worker accepted' >&2; exit 1; fi
grep -q 'stale receipt claim' "$WORK/stale"
token="$(sql -c "select lease_token from event_receipts where org_id='$org';")"
apply="select apply_event_projection('$org','race','live','race','$token');"
sql -c "begin; $apply select pg_sleep(0.3); commit;" >"$WORK/finish-a" 2>&1 & a=$!
sql -c "$apply" >"$WORK/finish-b" 2>&1 & b=$!
wait "$a"; wait "$b"
[[ "$(sql -c "select count(*) from event_read_models where org_id='$org';")" = 1 ]]
[[ "$(sql -c "select state from event_receipts where org_id='$org';")" = applied ]]
echo 'OK: concurrent publication/claims/completion, killed worker recovery, stale fencing, one projection effect'
