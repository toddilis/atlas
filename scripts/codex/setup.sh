#!/usr/bin/env bash
# Install both locked JavaScript workspaces during a Codex setup/maintenance phase, plus the
# PostgreSQL + pgvector binaries that `npm run check` needs for its database stage.
# This script does not connect to Shopify, Stripe, Supabase or a live database.
# Set ATLAS_SKIP_DB_TOOLS=1 to skip the PostgreSQL step.
set -euo pipefail

atlas_repo_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$atlas_repo_root"

command -v node >/dev/null || { echo "Atlas setup requires Node.js >=20." >&2; exit 1; }
command -v npm >/dev/null || { echo "Atlas setup requires npm." >&2; exit 1; }
node -e 'if (Number(process.versions.node.split(".")[0]) < 20) { console.error("Atlas setup requires Node.js >=20."); process.exit(1); }'

[[ -f package-lock.json && -f web/package-lock.json ]] || {
  echo "Run setup from a complete Atlas checkout containing both lockfiles." >&2
  exit 1
}

npm ci --no-audit --no-fund
npm --prefix web ci --no-audit --no-fund

echo "Atlas JavaScript dependencies are installed from both lockfiles."

# ---------- database tooling for `npm run check` ----------
# CI checks migrations against PostgreSQL 16 with pgvector. Installing the same server
# binaries lets builders run those checks before pushing instead of using CI as the test
# runner. Nothing is started or configured here: check.sh creates a throwaway cluster per
# run on 127.0.0.1 and deletes it afterwards.

db_tools_present() {
  local bin
  bin="$(ls -d /usr/lib/postgresql/*/bin 2>/dev/null | sort -V | tail -1 || true)"
  [[ -n "$bin" ]] && export PATH="$bin:$PATH"
  command -v initdb >/dev/null && command -v pg_config >/dev/null \
    && [[ -f "$(pg_config --sharedir)/extension/vector.control" ]]
}

install_db_tools() {   # Debian/Ubuntu (Codex cloud, WSL); root or passwordless sudo
  local sudo="" major
  if [[ $(id -u) -ne 0 ]]; then
    command -v sudo >/dev/null && sudo -n true 2>/dev/null || return 1
    sudo="sudo -n"
  fi
  $sudo env DEBIAN_FRONTEND=noninteractive apt-get update -qq || return 1
  if $sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
      postgresql-16 postgresql-16-pgvector >/dev/null; then
    return 0
  fi
  # Distributions without PostgreSQL 16: their default server plus the matching pgvector.
  $sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq postgresql >/dev/null || return 1
  major="$(ls /usr/lib/postgresql | sort -V | tail -1)"
  $sudo env DEBIAN_FRONTEND=noninteractive apt-get install -y -qq "postgresql-$major-pgvector" >/dev/null
}

if [[ "${ATLAS_SKIP_DB_TOOLS:-}" == 1 ]]; then
  echo "Skipped PostgreSQL/pgvector (ATLAS_SKIP_DB_TOOLS=1): npm run check will report its db stage as NOT RUN."
elif db_tools_present; then
  echo "PostgreSQL $(pg_config --version | awk '{print $2}') with pgvector found: npm run check can run every CI stage."
elif command -v apt-get >/dev/null && install_db_tools && db_tools_present; then
  echo "Installed PostgreSQL $(pg_config --version | awk '{print $2}') with pgvector: npm run check can run every CI stage."
else
  echo "PostgreSQL with pgvector is not available here, so npm run check will report its db stage as NOT RUN." >&2
  echo "Use a Debian/Ubuntu environment (Codex cloud, WSL) for database checks. Never point them at a live database." >&2
fi

echo "Before pushing, run: npm run check   (same steps as CI, with a throwaway database)."
echo "Read docs/development/CHATGPT_RUNBOOK.md for baseline and first-task commands."
