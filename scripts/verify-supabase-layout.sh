#!/usr/bin/env bash
# Re-runs every migration and probe in a sibling database laid out like hosted Supabase:
# pgcrypto and vector live in schema `extensions`, which the database search_path
# includes. A function that pins search_path=pg_catalog,public cannot see extension
# functions there (e.g. digest()), and the plain CI database cannot show that.
set -euo pipefail
: "${DATABASE_URL:?Set DATABASE_URL to the disposable verification database}"
case "$DATABASE_URL" in
  *@localhost[:/]*|*@127.0.0.1[:/]*) ;;
  *) echo 'refusing: creates and drops a database, so DATABASE_URL must be a local disposable server' >&2; exit 2 ;;
esac
db=atlas_supabase_layout
url="${DATABASE_URL%/*}/$db"
sql() { PGOPTIONS='-c client_min_messages=warning' psql "$DATABASE_URL" -X -q -v ON_ERROR_STOP=1 "$@"; }
sql -c "drop database if exists $db" -c "create database $db"
trap 'sql -c "drop database if exists $db with (force)" >/dev/null 2>&1 || true' EXIT
psql "$url" -X -q -v ON_ERROR_STOP=1 <<SQL
create schema extensions;
create extension pgcrypto with schema extensions;
create extension vector with schema extensions;
alter database $db set search_path = "\$user", public, extensions;
SQL
DATABASE_URL="$url" "$(dirname "$0")/verify-migrations.sh" >/dev/null
echo 'OK - migrations and probes pass with extensions in the Supabase extensions schema'
