# Deploying Atlas

Two deployables (decision D1/D7 in `PLAN.md`):

| Piece | Where | What runs |
|---|---|---|
| API + worker | Fly.io (one app, two process groups) | `dist/api/server.js`, `dist/worker/main.js` |
| Operator console | Vercel | `web/` (Next.js) |

The database is the existing Supabase project; migrations are applied there (in order,
`supabase/migrations/0001`→current) — the image deliberately contains no migration
tooling.

## API + worker → Fly.io

One-time setup:

```sh
fly launch --no-deploy --copy-config     # uses ./fly.toml + ./Dockerfile
fly secrets set \
  SUPABASE_URL=… \
  SUPABASE_SERVICE_ROLE_KEY=… \
  ATLAS_ORG_ID=… \
  ATLAS_API_TOKEN="$(openssl rand -hex 32)" \
  SHOPIFY_SHOP_DOMAIN=… \
  SHOPIFY_ADMIN_API_TOKEN=… \
  SHOPIFY_WEBHOOK_SECRET=… \
  SHOPIFY_MAIN_LOCATION_ID=… \
  VENUE_LOCATION_IDS=… \
  STRIPE_SECRET_KEY=… \
  STRIPE_WEBHOOK_SECRET=…
fly deploy
```

Then point the external webhooks at the app:

- Shopify fulfillment webhook → `https://<app>.fly.dev/webhooks/shopify/fulfillments`
- Stripe webhook (invoice.paid) → `https://<app>.fly.dev/webhooks/stripe`

Health:

- `/healthz` — liveness (process up; always 200 while running).
- `/readyz` — readiness (env present + database answers). Fly's http check uses this,
  so a machine with broken config or unreachable Supabase leaves rotation instead of
  answering 200 while webhooks fail behind it.

Operational notes:

- The API never scales to zero (`auto_stop_machines = false`) — webhooks need a listener.
- Both processes exit cleanly on SIGTERM: the API drains in-flight requests; the worker
  finishes its current tick. Fly's deploy flow relies on this.
- `/admin/*` (sync, outbox drain, replay) requires `Authorization: Bearer $ATLAS_API_TOKEN`.
  The worker makes the admin endpoints non-essential — it drains the outbox and replays
  outstanding projections every `WORKER_INTERVAL_MS` (default 60s).
- All secrets live in Fly (`fly secrets`); nothing is baked into the image.

## Console → Vercel

Import the repo in Vercel with **Root Directory = `web/`** (framework auto-detects
Next.js). Set environment variables:

```
SUPABASE_URL
SUPABASE_SERVICE_ROLE_KEY
ATLAS_ORG_ID
NEXT_PUBLIC_SUPABASE_URL          # same project URL — browser-safe
NEXT_PUBLIC_SUPABASE_ANON_KEY     # anon key — browser-safe, session handling only
ATLAS_OPERATOR_EMAILS             # comma-separated allowlist; empty = nobody signs in
```

One-time auth setup in the Supabase dashboard (Authentication):

1. Create the operator user (email + password) under Users.
2. Disable public sign-ups (Providers → Email → turn off sign-ups). The console's
   allowlist fails closed regardless, but there's no reason to accept strangers'
   accounts into the auth table.

Keep Vercel Deployment Protection enabled until an allowed operator has passed login,
session refresh and sign-out, and a non-allowlisted account has been denied in production.

The service-role key stays server-side (all pages are server components) and only runs
behind the request proxy session gate (PR-P, decision D3). Real RLS-scoped access is a v2
multi-tenant item.
