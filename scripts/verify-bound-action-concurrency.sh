#!/usr/bin/env bash
# Separate sessions against the disposable CI database only.
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to the disposable verification database}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
sql() { psql "$DATABASE_URL" -X -qAt -v ON_ERROR_STOP=1 "$@"; }
org='40000000-0000-4000-8000-000000000001'
sql -c "insert into orgs(id,slug,display_name) values('$org','bound-race','Synthetic action race'); insert into tool_grants(org_id,agent_name,tool_name,risk) values('$org','fixture','fixture.race','approve_required');" >/dev/null
approval="$(sql -c "select create_bound_approval('$org',jsonb_build_object('schema_version',1,'org_id','$org','agent_name','fixture','tool_name','fixture.race','subject_type','fixture','subject_id',null,'input','{}'::jsonb,'subject_snapshot','{}'::jsonb,'policy_snapshot',null),now()+interval '1 hour');")"
sql -c "select decide_bound_approval('$org','$approval','approved','fixture-operator');" >/dev/null
claim="select claim_bound_action('$org','$approval','fixture-worker','null','{}');"
sql -c "begin; $claim select pg_sleep(0.3); commit;" >"$WORK/a" 2>&1 & a=$!
sql -c "begin; $claim select pg_sleep(0.3); commit;" >"$WORK/b" 2>&1 & b=$!
ra=0; rb=0
wait "$a" || ra=$?
wait "$b" || rb=$?
if ! { [[ "$ra" = 0 && "$rb" != 0 ]] || [[ "$ra" != 0 && "$rb" = 0 ]]; }; then
  cat "$WORK/a" "$WORK/b"; echo 'expected exactly one action claimant' >&2; exit 1
fi
grep -q 'action already claimed or unresolved' "$WORK/a" "$WORK/b"
[[ "$(sql -c "select count(*) from action_attempts where org_id='$org';")" = '1' ]]
# A committed claim survives worker loss and must not grant another execution.
if sql -c "$claim" >"$WORK/restart" 2>&1; then echo 'restart duplicated claimed action' >&2; exit 1; fi
grep -q 'action already claimed or unresolved' "$WORK/restart"
echo 'OK - concurrent approval claim and restart refusal'
