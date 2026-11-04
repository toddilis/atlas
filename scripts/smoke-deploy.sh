#!/usr/bin/env bash
# Post-deploy smoke check (docs/operations/GO_LIVE.md step 11): the API is up and ready,
# its Shopify webhook refuses a forged request, and the console is up and admits nobody
# without a session. Needs no secrets and changes nothing.
#
#   scripts/smoke-deploy.sh https://atlas-api.fly.dev https://<console-domain>
#
# Exits non-zero if any check fails. While Vercel Deployment Protection is on, the console
# checks see Vercel's own sign-in instead; check the console by hand until it is off.
set -uo pipefail

api="${1:-}"; console="${2:-}"
if [[ -z "$api" || -z "$console" ]]; then
  echo "usage: $0 <api-url> <console-url>" >&2; exit 2
fi
api="${api%/}"; console="${console%/}"
failed=0

pass() { echo "ok: $1"; }
fail() { echo "FAIL: $1" >&2; failed=1; }
# Status code (and redirect target) of one request; 000 when it could not connect.
status() { curl -sS -o /dev/null --max-time 20 -w '%{http_code}' "$@" 2>/dev/null || true; }

code="$(status "$api/healthz")"
[[ "$code" == 200 ]] && pass "API is up (/healthz 200)" || fail "API /healthz answered ${code:-nothing}; check fly status and fly logs"

ready="$(curl -sS --max-time 20 "$api/readyz" 2>/dev/null || true)"
code="$(status "$api/readyz")"
if [[ "$code" == 200 ]]; then pass "API is ready: its settings are present and the database answers (/readyz 200)"
else fail "API /readyz answered ${code:-nothing}: ${ready:-no body}. A setting is missing (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, ATLAS_ORG_ID) or the database does not answer"; fi

# A request with a wrong signature is refused (401) only when SHOPIFY_WEBHOOK_SECRET is set;
# without it the API cannot check signatures and fails (500).
code="$(status -X POST -H 'content-type: application/json' -H 'x-shopify-hmac-sha256: smoke-check-not-a-signature' \
  -H 'x-shopify-shop-domain: smoke-check.myshopify.com' --data '{}' "$api/webhooks/shopify/fulfillments")"
case "$code" in
  401) pass "Shopify webhook refuses a forged request (401)" ;;
  500) fail "Shopify webhook failed (500): SHOPIFY_WEBHOOK_SECRET is probably not set on the API" ;;
  *) fail "Shopify webhook answered ${code:-nothing} to a forged request; expected 401" ;;
esac

code="$(status "$console/login")"
[[ "$code" == 200 ]] && pass "console sign-in page loads (/login 200)" || fail "console /login answered ${code:-nothing}"

code="$(status "$console/api/session")"
case "$code" in
  401) pass "console refuses a request without a session (/api/session 401)" ;;
  503) fail "console says operator access is not configured (503): set NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY and ATLAS_OPERATOR_EMAILS on Vercel" ;;
  *) fail "console /api/session answered ${code:-nothing} without a session; expected 401" ;;
esac

target="$(curl -sS -o /dev/null --max-time 20 -w '%{http_code} %{redirect_url}' "$console/setup" 2>/dev/null || true)"
if [[ "$target" =~ ^30[1278]\ .*/login$ ]]; then pass "console pages send a visitor without a session to /login"
else fail "console /setup without a session answered '${target:-nothing}'; expected a redirect to /login"; fi

if [[ "$failed" == 0 ]]; then
  echo "All smoke checks passed. Next: sign in and open /setup for the business checklist."
else
  echo "Some smoke checks failed; see above." >&2
fi
exit "$failed"
