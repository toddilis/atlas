#!/usr/bin/env bash
# Install both locked JavaScript workspaces during a Codex setup/maintenance phase.
# This script does not connect to Shopify, Stripe, Supabase or a live database.
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
echo "Database acceptance remains a separate gate: use disposable Postgres with pgvector."
echo "Read docs/development/CHATGPT_RUNBOOK.md for baseline and first-task commands."
