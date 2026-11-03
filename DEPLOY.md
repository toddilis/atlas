# Deploying Atlas

Two deployables (decisions D1/D7 in `PLAN.md`), both against the business's existing
Supabase project:

| Piece | Where | What runs |
|---|---|---|
| API + worker | Fly.io (app `atlas-api`, one image, two process groups) | `dist/api/server.js`, `dist/worker/main.js` |
| Operator console | Vercel (Root Directory `web/`) | Next.js app in `web/` |

Migrations are applied to the database by hand, in order; the image deliberately
contains no migration tooling.

**First deploy and go-live:** follow [docs/operations/GO_LIVE.md](docs/operations/GO_LIVE.md).
It has every setting for Fly and Vercel, the business record, the switches a business
turns on deliberately, the Shopify setup, the first-day console setup and the checks.

## Deploying a new version

1. Back up the database and apply any new migrations, in order, before the code that
   needs them ([GO_LIVE.md step 2](docs/operations/GO_LIVE.md#2-bring-the-database-schema-up-to-date)).
2. `fly deploy` from the merged commit. Starting the API and worker adds any new
   standard switch for the business; it never turns a switched-off one back on.
3. Deploy the console from the same commit (Vercel deploys `main` when the Git
   integration is on).
4. Run the health check ([GO_LIVE.md step 11](docs/operations/GO_LIVE.md#11-health-check-after-this-deploy-and-every-later-one)):
   `scripts/smoke-deploy.sh <api-url> <console-url>`, the schema status query and the
   console's Setup page.
5. If the release adds a switch that is never turned on automatically, decide whether
   the business wants it ([GO_LIVE.md step 6](docs/operations/GO_LIVE.md#6-turn-on-the-day-one-switches)).

## Health endpoints

- `/healthz`: liveness (the process is up; always 200 while running).
- `/readyz`: readiness (its settings are present and the database answers). Fly's HTTP
  check uses it, so a machine with broken settings or no database leaves rotation
  instead of answering 200 while webhooks fail behind it. A business id that is not in
  `orgs` stops the API and worker at start instead (`api.fatal` in `fly logs`).

## Operational notes

- The API never scales to zero (`auto_stop_machines = false`): webhooks need a listener.
- Both processes exit cleanly on SIGTERM: the API drains in-flight requests and the
  worker finishes its current tick. Fly's deploy flow relies on this.
- The worker runs every background job each `WORKER_INTERVAL_MS` (default 60s): outbox
  drain, projection replay, Shopify sync, carrier costs, invoice part drafts, approved
  actions and the daily briefing. Jobs are leased, so a second worker machine is safe
  but unnecessary.
- `/admin/*` (sync, outbox drain, replay, approvals) requires
  `Authorization: Bearer $ATLAS_API_TOKEN`; the worker makes it non-essential.
- `/webhooks/stripe` serves the legacy Stripe loop only. The pilot is paid by bank
  transfer, so its settings stay unset.
- All secrets live in Fly (`fly secrets`) and Vercel; nothing is baked into the image.
- The console's service-role key stays server-side (every page is a server component)
  and runs only behind the request proxy's session, allowlist and membership gate
  (PR-P, D3, 0049). Shared-tenancy data access is a later item; one deployment serves
  one business.
