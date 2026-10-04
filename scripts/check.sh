#!/usr/bin/env bash
# check.sh — run this branch's CI gates locally, before pushing.
#
#   npm run check                 # all stages: app, web, db
#   npm run check -- app db       # chosen stages: app | web | db
#   CHECK_VERBOSE=1 npm run check # stream every command's full output
#
# The commands come from this checkout's own .github/workflows/atlas-ci.yml (jobs `test`,
# `web` and `migrations`), so a branch that adds a CI probe is checked with that probe and
# nothing here needs updating. `npm ci` steps are skipped: install once with
# `bash scripts/codex/setup.sh`.
#
# The db stage never uses a DATABASE_URL from your environment. It creates a throwaway
# Postgres cluster listening only on 127.0.0.1, points DATABASE_URL at it for the CI
# commands, and deletes it on exit. It needs PostgreSQL server binaries and pgvector
# (scripts/codex/setup.sh installs both on Debian/Ubuntu, including WSL). If they are
# missing the stage is reported as NOT RUN and the exit status is non-zero: not a pass.
#
# Output stays short on purpose: a passing step prints one line; a failing step prints the
# last CHECK_TAIL lines (default 60) of its log. Full logs stay on disk.
# Exit status: 0 all requested stages passed, 1 a stage failed, 2 a stage could not run.
# The browser acceptance workflow (auth-browser.yml) needs Docker and is not run here.
set -euo pipefail

ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
WORKFLOW=".github/workflows/atlas-ci.yml"
TAIL_LINES="${CHECK_TAIL:-60}"
LOG_DIR="$(mktemp -d "${TMPDIR:-/tmp}/atlas-check.XXXXXX")"
DB_WORK=""
STEP=1

[[ -f "$WORKFLOW" ]] || { echo "check: $WORKFLOW not found" >&2; exit 2; }

stages=("$@")
[[ ${#stages[@]} -eq 0 ]] && stages=(app web db)
for s in "${stages[@]}"; do
  case "$s" in app|web|db) ;; *) echo "check: unknown stage '$s' (use app, web or db)" >&2; exit 2 ;; esac
done

# Print the single-line `- run:` commands of one workflow job, in order.
job_steps() {
  awk -v job="$1" '
    $0 ~ "^  " job ":[[:space:]]*$" { injob = 1; next }
    injob && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ { injob = 0 }
    injob && /^[[:space:]]+- run: / { sub(/^[[:space:]]+- run: /, ""); print }
  ' "$WORKFLOW"
}

# Run one command in directory $2 with no stdin; print one line, or the failing log tail.
run_step() {
  local cmd="$1" dir="$2" log start rc=0
  log="$LOG_DIR/$(printf '%02d' "$STEP").log"; STEP=$((STEP + 1))
  start=$(date +%s)
  if [[ "${CHECK_VERBOSE:-}" == 1 ]]; then
    echo "  > $cmd"
    set +e
    (cd "$dir" && bash -c "$cmd" </dev/null) 2>&1 | tee "$log"
    rc=${PIPESTATUS[0]}
    set -e
  else
    (cd "$dir" && bash -c "$cmd" </dev/null) >"$log" 2>&1 || rc=$?
  fi
  if [[ $rc -eq 0 ]]; then
    echo "  ok   $cmd ($(( $(date +%s) - start ))s)"
    return 0
  fi
  echo "  FAIL $cmd (exit $rc) - last $TAIL_LINES lines of $log:"
  tail -n "$TAIL_LINES" "$log" | sed 's/^/       /'
  if [[ "$cmd" == *"git diff --exit-code"*"database.types.ts"* ]]; then
    echo "       The regenerated src/data/database.types.ts is in your working tree: review and commit it."
  fi
  return 1
}

run_job() {   # job name, working directory
  local job="$1" dir="$2" cmd steps=()
  while IFS= read -r cmd; do
    [[ -z "$cmd" || "$cmd" == "npm ci"* ]] || steps+=("$cmd")
  done < <(job_steps "$job")
  if [[ ${#steps[@]} -eq 0 ]]; then
    echo "  FAIL no run steps found for job '$job' in $WORKFLOW"
    return 1
  fi
  for cmd in "${steps[@]}"; do
    run_step "$cmd" "$dir" || return 1
  done
}

pg_user_exec() {   # PostgreSQL refuses to run its cluster as root
  if [[ $(id -u) -eq 0 ]]; then su -s /bin/bash postgres -c "PATH=\"$PATH\"; $1"; else bash -c "$1"; fi
}

stop_db() {
  if [[ -n "$DB_WORK" && -d "$DB_WORK" ]]; then
    pg_user_exec "pg_ctl -D '$DB_WORK/data' -m immediate stop" >/dev/null 2>&1 || true
    rm -rf "$DB_WORK"
  fi
  DB_WORK=""
}
trap stop_db EXIT

start_db() {
  local pg_bin port="" p
  pg_bin="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [[ -n "$pg_bin" ]] && export PATH="$pg_bin:$PATH"
  if ! command -v initdb >/dev/null || ! command -v pg_ctl >/dev/null; then
    echo "  NOT RUN: PostgreSQL server binaries (initdb, pg_ctl) not found."
    echo "           Install them with: bash scripts/codex/setup.sh   (Debian/Ubuntu, incl. WSL)"
    return 2
  fi
  if [[ ! -f "$(pg_config --sharedir 2>/dev/null)/extension/vector.control" ]]; then
    echo "  NOT RUN: pgvector is not installed for $(pg_config --version 2>/dev/null || echo 'this PostgreSQL')."
    echo "           Install it with: bash scripts/codex/setup.sh"
    return 2
  fi
  # /tmp rather than TMPDIR: the postgres OS user must be able to reach the data directory.
  DB_WORK="$(mktemp -d /tmp/atlas-check-db.XXXXXX)"
  [[ $(id -u) -eq 0 ]] && chown postgres:postgres "$DB_WORK"
  for p in $(seq 55432 55531); do
    if ! (exec 3<>"/dev/tcp/127.0.0.1/$p") 2>/dev/null; then port=$p; break; fi
  done
  [[ -n "$port" ]] || { echo "  NOT RUN: no free local port in 55432-55531"; return 2; }
  if ! { pg_user_exec "initdb -D '$DB_WORK/data' -U postgres -A trust" \
      && pg_user_exec "pg_ctl -D '$DB_WORK/data' -o \"-p $port -c listen_addresses=127.0.0.1 -k '$DB_WORK'\" -w -l '$DB_WORK/pg.log' start" \
      && pg_user_exec "createdb -h 127.0.0.1 -p $port -U postgres atlas_verify"; } >"$LOG_DIR/database.log" 2>&1; then
    echo "  NOT RUN: could not start a throwaway cluster (see $LOG_DIR/database.log)"
    return 2
  fi
  export DATABASE_URL="postgres://postgres@127.0.0.1:$port/atlas_verify"
  echo "  throwaway database on 127.0.0.1:$port (deleted when this stage ends)"
}

[[ -d node_modules ]] || echo "warning: node_modules missing - run: bash scripts/codex/setup.sh"

status=0
summary=()
for s in "${stages[@]}"; do
  echo "== $s"
  outcome=passed
  case "$s" in
    app) run_job test "$ROOT" || outcome=FAILED ;;
    web) run_job web "$ROOT/web" || outcome=FAILED ;;
    db)
      unset DATABASE_URL GEN_TYPES_DATABASE_URL
      rc=0; start_db || rc=$?
      if [[ $rc -ne 0 ]]; then outcome="NOT RUN"
      else run_job migrations "$ROOT" || outcome=FAILED
      fi
      stop_db
      ;;
  esac
  case "$outcome" in
    FAILED) status=1 ;;
    "NOT RUN") [[ $status -eq 0 ]] && status=2 ;;
  esac
  summary+=("$(printf '  %-4s %s' "$s" "$outcome")")
done

dirty=""
git diff --quiet && git diff --cached --quiet || dirty=", with uncommitted changes"
echo "== summary for $(git rev-parse --short HEAD)$dirty"
printf '%s\n' "${summary[@]}"
echo "  logs: $LOG_DIR"
exit "$status"
