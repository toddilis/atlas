# Go-live runbook

How to take Atlas from merged code to a business issuing and getting paid for its first
real invoice: deploy the API and worker (Fly.io) and the console (Vercel) against the
business's Supabase project, set the business up, and check that it all works.

Follow the steps in order. Each step ends with a check; do not move on until it passes.
The whole run takes about half a day, most of it the first-day setup in step 8. Nothing in
this runbook is automated: every command runs on your own machine or in a dashboard,
with your own credentials. Never paste a secret into chat, a ticket or the repository.

Written for VICE, the first business. Another business follows the same steps with its
own values. Where this says "business id", it means that business's row in `orgs`
(step 3), which is also `ATLAS_ORG_ID`.

| Step | What | Where |
|---|---|---|
| 1 | Back up the database | Supabase |
| 2 | Bring the database schema up to date | Supabase SQL editor, `psql` |
| 3 | Create the business record and its chart of accounts | Supabase SQL editor |
| 4 | Deploy the API and worker | Fly.io |
| 5 | Deploy the console and set up sign-in | Vercel, Supabase Auth |
| 6 | Turn on the day-one switches | Supabase SQL editor |
| 7 | Prepare Shopify | Shopify admin, Fly.io |
| 8 | First-day setup in the console | Console |
| 9 | Turn on the Shopify fulfillment webhook | Shopify admin |
| 10 | First real invoice, from approval to payment | Console |
| 11 | Health check (repeat after every deploy) | Terminal, console |
| 12 | Pause, roll back or switch off | Console, Fly.io, Vercel |

## Before you start

You need:

- Owner access to the Supabase project, Fly.io (with `fly` installed and signed in),
  Vercel (linked to this GitHub repository), the Shopify admin, and GoSweetSpot if your
  pricing charges actual freight.
- `psql` and `pg_dump` (PostgreSQL 16 client) on your machine, and the database
  connection string from Supabase → Project Settings → Database. This runbook calls it
  `$SUPABASE_DB_URL`. Keep it in your shell only.
- An hour where no wholesale order ships, for steps 8 and 9.

Collect these values first (from the dashboards named; none of them goes in the repo):

| Value | From |
|---|---|
| Project URL, `anon` key, `service_role` key | Supabase → Project Settings → API |
| Shop domain (`<shop>.myshopify.com`) | Shopify admin → Settings → Domains |
| Admin API access token | Shopify custom app (step 7) |
| Webhook signing secret | Shopify admin → Settings → Notifications → Webhooks (step 7) |
| Main warehouse location id, venue location ids | Shopify admin → Settings → Locations (step 7) |
| GoSweetSpot access key and site id | GoSweetSpot account (only if freight is charged at cost) |
| Anthropic API key | Optional: only for the assistant and the daily briefing |
| Email of everyone who will use the console | You |

## 1. Back up the database

Supabase → Database → Backups: confirm a backup from today exists. Also take your own
copy, since step 2 changes the schema:

```sh
pg_dump "$SUPABASE_DB_URL" --format=custom --file "atlas-before-go-live-$(date +%Y%m%d).dump"
```

Check: the file exists and is not empty. Keep it until the first invoice is paid.

## 2. Bring the database schema up to date

Migrations are applied by hand, in order; the deployed code assumes all of them.

1. Supabase → SQL editor: paste and run [`scripts/go-live/schema-status.sql`](../../scripts/go-live/schema-status.sql).
   It changes nothing. It returns one row per migration with `applied`:
   - `true`: the first thing that migration creates exists, so it has been applied;
   - `false`: it has not been applied;
   - empty (null) for 0010, 0016, 0027, 0046, 0050 and 0055, which create nothing new to look
     for. Count one as applied when the migration after it is.
2. Note the first migration whose `applied` is `false`, for example `0047`. Apply it and
   every later one, in order, each in its own transaction, stopping at the first error:

   ```sh
   FIRST=0047   # the first migration not yet applied
   for f in $(ls supabase/migrations/0*.sql | sort); do
     n="$(basename "$f" | cut -c1-4)"
     [[ "$n" < "$FIRST" ]] && continue
     echo "applying $f"
     psql "$SUPABASE_DB_URL" --single-transaction -v ON_ERROR_STOP=1 -f "$f" || { echo "STOPPED at $f"; break; }
   done
   ```

   Run it from the repository root on the commit you are deploying. A failed migration
   leaves nothing behind, because each file is one transaction. Do not skip it and carry
   on: keep the error text and stop here.
3. In the SQL editor, run `notify pgrst, 'reload schema';` so the Supabase API sees the
   new functions at once.

Check: `schema-status.sql` shows no `false` row.

## 3. Create the business record and its chart of accounts

Once per business. In the SQL editor:

```sql
select id, slug, display_name, base_currency, gst_rate_bps from orgs;
```

If the business is listed, its `id` is the business id. If not, create it (the slug and
name here are VICE's; the display name shows in the console and on documents until the
business profile is saved in step 8):

```sql
insert into orgs (slug, display_name) values ('vice', 'VICE') returning id;
```

New businesses default to NZD and 15% GST (`base_currency`, `gst_rate_bps = 1500`).
Change them now if they are wrong for the business.

Then seed the chart of accounts that issued invoices and payments post to. It is safe to
run twice:

```sql
select seed_chart_of_accounts('<business id>');
select code, display_name from ledger_accounts where org_id = '<business id>' order by code;
```

Check: the chart is listed: 1000 Cash, 1100 Accounts Receivable, 2200 Sales Tax Payable,
4000 Revenue - Wholesale and the rest.

## 4. Deploy the API and worker (Fly.io)

One Fly app (`atlas-api`, Singapore, next to the database) runs two processes from one
image: `api` (webhooks and health checks) and `worker` (every background job: Shopify
sync, carrier costs, invoice drafting, approved actions, the daily briefing).

First time only, from the repository root:

```sh
fly launch --no-deploy --copy-config
```

Fly app names are global. If `atlas-api` is taken, choose another name and use
`<that name>.fly.dev` wherever this runbook says `atlas-api.fly.dev`.

Set the secrets. Each process reads all of them.

```sh
fly secrets set \
  SUPABASE_URL='https://<project>.supabase.co' \
  SUPABASE_SERVICE_ROLE_KEY='<service_role key>' \
  ATLAS_ORG_ID='<business id>' \
  ATLAS_API_TOKEN="$(openssl rand -hex 32)" \
  SHOPIFY_SHOP_DOMAIN='<shop>.myshopify.com' \
  SHOPIFY_ADMIN_API_TOKEN='<Admin API access token>' \
  SHOPIFY_WEBHOOK_SECRET='<webhook signing secret>' \
  SHOPIFY_MAIN_LOCATION_ID='<main warehouse location id>' \
  VENUE_LOCATION_IDS='<venue location id>,<venue location id>'
```

If the Shopify values are not ready yet, set the first four now and the rest in step 7.

| Setting | Needed for | If missing |
|---|---|---|
| `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `ATLAS_ORG_ID` | Everything | The API and worker stop at start or `/readyz` fails, so Fly keeps the API out of service |
| `ATLAS_API_TOKEN` | The `/admin/*` endpoints (not used by the console) | They refuse every call |
| `SHOPIFY_SHOP_DOMAIN`, `SHOPIFY_ADMIN_API_TOKEN` | The worker's Shopify sync, every 15 minutes | Nothing syncs from Shopify |
| `SHOPIFY_WEBHOOK_SECRET` | Accepting the fulfillment webhook | Every webhook call fails, so no shipment is invoiced |
| `SHOPIFY_MAIN_LOCATION_ID` | Recognising wholesale shipments | Every shipment is ignored |
| `VENUE_LOCATION_IDS` | Recognising consignment (venue) shipments | Venue shipments are ignored |
| `GOSWEETSPOT_ACCESS_KEY`, `GOSWEETSPOT_SITE_ID`, `GOSWEETSPOT_COST_CURRENCY` (`NZD`) | Carrier costs, when pricing charges actual freight | An order's first part waits for its freight cost (see step 7) |
| `ANTHROPIC_API_KEY` | The daily briefing, with the `assistant.narrate` switch | No briefing; the home page still shows every figure |
| `ATLAS_ADMIN_ACTOR_ID` | Deciding approvals through `/admin` with the API token | Those endpoints refuse; the console is unaffected |

Leave the Stripe settings unset: VICE is paid by bank transfer, and the Stripe path is
not part of the pilot. Optional tuning: `WORKER_INTERVAL_MS` (default 60000),
`ATLAS_APPROVAL_TTL_SECONDS` (3600), `GOSWEETSPOT_COST_VALIDITY_DAYS` (30),
`SHOPIFY_API_VERSION` (2025-01), `ANTHROPIC_MODEL`.

Deploy:

```sh
fly deploy
fly status
```

Checks:

- `fly status` lists `api` and `worker` machines, all `started`. One of each is enough.
  Machines that keep restarting log the reason as `api.fatal` or `worker.fatal` in
  `fly logs`; a business id that is not in `orgs` stops both at start.
- `curl https://atlas-api.fly.dev/readyz` returns `{"ok":true}`.
- `fly logs` shows `worker.started`, then `worker.tick` about once a minute.
- When the API and worker start they add this business's standard switches (step 6).
  In the SQL editor, `select count(*) from tool_grants where org_id = '<business id>' and agent_name = 'operator';`
  returns at least 21.

## 5. Deploy the console and set up sign-in (Vercel, Supabase Auth)

In Vercel, import this repository with **Root Directory `web/`** (Next.js is detected).
Under Settings → Functions, choose Singapore (`sin1`) so pages load next to the
database. Set these environment variables for Production:

| Variable | Value |
|---|---|
| `SUPABASE_URL` | Project URL |
| `SUPABASE_SERVICE_ROLE_KEY` | `service_role` key (server only; never a `NEXT_PUBLIC_` variable) |
| `ATLAS_ORG_ID` | Business id |
| `NEXT_PUBLIC_SUPABASE_URL` | Project URL again (safe in the browser) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | `anon` key (safe in the browser; sign-in only) |
| `ATLAS_OPERATOR_EMAILS` | Comma-separated emails allowed to sign in. Empty means nobody can |
| `ANTHROPIC_API_KEY`, `ANTHROPIC_MODEL` | Optional: only for the assistant (`assistant.ask`) |

Deploy, and keep Vercel Deployment Protection on until the sign-in checks below pass.

In Supabase → Authentication:

1. Users → Add user → Create new user, for each email on `ATLAS_OPERATOR_EMAILS`, with a
   password and "Auto Confirm User" ticked.
2. Turn off "Allow new users to sign up". The console refuses anyone not on the list
   anyway; this keeps strangers out of the user table.

Checks, in the console:

- An operator on the list signs in and lands on the home page; signing out returns to
  the sign-in page.
- A Supabase user who is not on `ATLAS_OPERATOR_EMAILS` is refused.
- Then turn Deployment Protection off (or keep it, if every operator can pass Vercel's
  own sign-in).

## 6. Turn on the day-one switches

Every business action checks a switch (a `tool_grants` row) for this business. Starting
the API and worker turns on the standard ones: retrying and dismissing jobs, pricing,
the catalogue, the business profile, connections, approvals, statements, bank imports,
reminders, recording prints, deciding Shopify customers, and the emergency stop. Any of them can be turned off and a
restart never turns it back on.

The switches below are never turned on automatically, so the business decides. There is
no console control for them yet: run the SQL in the Supabase SQL editor. The console's
Setup page (`/setup`) shows each one's state and the exact SQL for this business.

| Switch | Allows | Day one? |
|---|---|---|
| `controller.issue_invoice` | Approving and issuing an invoice part exactly as shown | Yes |
| `payments.record` | Recording a payment, by hand or from a matched bank receipt | Yes |
| `members.save` | Adding or disabling the people who may use the console | Yes |
| `invoices.void` | Voiding a wrongly issued invoice (its posting is reversed) | When needed |
| `carriers.record_manual_cost` | Entering a freight cost by hand for a parcel GoSweetSpot cannot cost, such as a hand courier | When needed |
| `assistant.ask` | Asking the read-only assistant; spends model credit | Optional |
| `assistant.narrate` (agent `assistant`) | The daily briefing on the home page; spends model credit | Optional |

Turn on the three day-one switches:

```sql
insert into tool_grants (org_id, agent_name, tool_name, risk, enabled) values
  ('<business id>', 'operator', 'controller.issue_invoice', 'approve_required', true),
  ('<business id>', 'operator', 'payments.record', 'notify', true),
  ('<business id>', 'operator', 'members.save', 'notify', true)
on conflict (org_id, agent_name, tool_name) do update set enabled = true;
```

Keep `approve_required` on `controller.issue_invoice`: the "Approve and issue" button
is that approval, for the exact part on screen. The others use `notify`. Turn any switch
off with:

```sql
update tool_grants set enabled = false
where org_id = '<business id>' and agent_name = 'operator' and tool_name = '<switch>';
```

`assistant.narrate` uses `agent_name = 'assistant'`. The console hides or refuses a
switched-off action and changes nothing.

Check: the console's Setup page shows "Day-one switches: Done".

## 7. Prepare Shopify

**Admin API token.** Use the shop's existing custom app for Atlas if there is one;
otherwise create one (Shopify admin → Settings → Apps and sales channels → Develop apps,
or Shopify's Dev Dashboard if the admin sends you there). It needs read access only:
`read_orders`, `read_customers` and `read_products` (orders carry their fulfillments).
Install it and copy the Admin API access token into `SHOPIFY_ADMIN_API_TOKEN`. Atlas never
writes to Shopify.

**Webhook signing secret.** At the bottom of Shopify admin → Settings → Notifications,
the Webhooks section says "Your webhooks will be signed with …". That value is
`SHOPIFY_WEBHOOK_SECRET`. Do not add the webhook yet: that is step 9. If the key is only
shown once a webhook exists, do step 9 first and set the secret straight after; Shopify
retries the deliveries that failed in between.

**Locations.** Shopify admin → Settings → Locations. Open the warehouse that ships
wholesale orders: the number at the end of the page address is
`SHOPIFY_MAIN_LOCATION_ID`. Do the same for each venue that holds consignment stock and
list them, comma-separated, in `VENUE_LOCATION_IDS`. A shipment from the main location
to a linked retailer is invoiced; one from a venue is consignment; anything else is
ignored, including web orders (Shopify has already been paid for those).

Set what is still missing, which restarts both processes:

```sh
fly secrets set SHOPIFY_SHOP_DOMAIN=… SHOPIFY_ADMIN_API_TOKEN=… SHOPIFY_WEBHOOK_SECRET=… \
  SHOPIFY_MAIN_LOCATION_ID=… VENUE_LOCATION_IDS=…
```

**Freight.** If your pricing will charge freight at actual or adjusted carrier cost, an
order's first invoice part waits until that shipment's cost is known. Set
`GOSWEETSPOT_ACCESS_KEY`, `GOSWEETSPOT_SITE_ID` and `GOSWEETSPOT_COST_CURRENCY=NZD` the
same way before the first wholesale shipment. A fixed freight rule, or none, needs no
GoSweetSpot.

Check: `scripts/smoke-deploy.sh` (step 11) reports "Shopify webhook refuses a forged
request (401)".

## 8. First-day setup in the console

Sign in and open **Setup** in the top bar: it is the checklist for this step and reads
the business's own records every time. Work down it in this order.

1. **Business profile** (Business): legal name, GST number, address and payment
   instructions (the bank account retailers pay into). They print on every invoice,
   statement and reminder.
2. **Shopify connection** (Connections): connect `<shop>.myshopify.com`, the same domain
   as `SHOPIFY_SHOP_DOMAIN`. The worker syncs it within a minute and then every 15
   minutes. Setup shows "last synced"; if it says "has never synced", the Jobs page says
   why. The first sync brings in customers, orders and every product variant, keyed by
   SKU. Each variant you sell wholesale needs a SKU in Shopify: a shipped line without
   one cannot be priced.
3. **Retailers** (Catalogue): add each retailer you invoice, with its currency, payment
   terms, billing email and whether it is tax-exempt (export). Products are already
   there from Shopify.
4. **Decide your retailers' Shopify customers** (Customers). Atlas invoices a shipment
   from the warehouse when its order's Shopify customer is linked to a retailer and
   Shopify shows the order unpaid. An order Shopify shows as paid is never invoiced. Each
   Shopify customer is either linked to a retailer, marked not invoiced (a rep or staff
   member, with a reason), or undecided. When an unpaid draft order ships for an
   undecided customer, it waits on the Customers page, and under Needs you on the home
   page, until you decide; your decision sends it to invoicing or sets it aside.
   So you can link customers as their orders ship, but linking your regular retailers
   now saves a wait: search by name, email or company, then Link. A retailer can have
   several Shopify customers (one per buyer, or duplicates); link each one. When a
   customer's company or email matches a retailer, the page suggests it. Later syncs
   keep every decision.
5. **Pricing** (Pricing): build the first version with your wholesale prices, freight
   rule and payment terms; preview a retailer to check a real order prices as you
   expect; save; activate. Nothing can be drafted until a version is active.
6. **Bank accounts** (Bank), optional on day one: add the account retailers pay into, to
   import its statements and match receipts to invoices. Imports are CSV files with a
   header row of `date` (YYYY-MM-DD), `amount` (signed, like `-45.20`) and
   `description`, plus `reference`, `counterparty`, `transaction_id` and `currency`
   when the bank gives them; a bank's own export may need its columns renamed first.
   Payments can be recorded by hand on the invoice page meanwhile.
7. **Members** (Members): add yourself first, then each other operator. Until the first
   member is added, anyone on `ATLAS_OPERATOR_EMAILS` can sign in; afterwards only
   enabled members on that list can.

Check: every Business setup line on the Setup page is Done, except "First real invoice"
and, if you skipped them, bank accounts.

## 9. Turn on the Shopify fulfillment webhook

This is the moment Atlas starts invoicing, so it is also the activation cutoff: Atlas
invoices shipments from here on, and what retailers owed before stays outside it. The
exact cutoff and the handling of orders invoiced before it are still an open decision
([VICE_RECEIVABLES](../product/VICE_RECEIVABLES.md), input 6). Settle one case first: an
order that shipped partly before the cutoff and ships again after it. The first sync
recorded the earlier shipment, and with first-part freight Atlas waits for it to be
invoiced in Atlas, which never happens. The new shipment's part therefore stays blocked
with "an earlier shipment of this order must be invoiced first". Until that case is
built, invoice such a shipment outside Atlas as before, and dismiss its job on the Jobs
page giving that as the reason.

Shopify admin → Settings → Notifications → Webhooks → Create webhook:

- Event: **Fulfillment creation**
- Format: JSON
- URL: `https://atlas-api.fly.dev/webhooks/shopify/fulfillments`
- Webhook API version: the same version as `SHOPIFY_API_VERSION`. Its default, 2025-01,
  has probably left Shopify's supported list; if it is not offered, pick the oldest
  version that is and set `SHOPIFY_API_VERSION` to it (`fly secrets set …`), so the sync
  and the webhook read the same shapes.

If a fulfillment webhook already points at an older Atlas address, change its URL
instead of adding a second one. Do not use "Send test notification": its sample
shipment is not a real order.

Atlas stores each shipment as soon as Shopify sends it, but files it only once its order
has synced, so a shipment of an order placed in the last 15 minutes waits for the next
sync. Until then the webhook answers with an error and Shopify retries it; that is
expected. If Shopify emails that the webhook keeps failing, check the Jobs page and
`fly logs`.

Check: after the next shipment, the SQL editor shows how it was routed:

```sql
select occurred_at, route, reason from fulfillment_events
where org_id = '<business id>' order by occurred_at desc limit 5;
```

A linked retailer's unpaid shipment from the main warehouse shows `wholesale`; an
undecided customer's unpaid draft order shows `held` and waits on Customers (step 8.4);
an order Shopify shows as paid shows `ignored`, with the reason.

## 10. First real invoice, from approval to payment

1. A retailer's order ships from the main warehouse. Usually within 20 minutes (step 9)
   the worker drafts its invoice part: the home page counts it, and it is listed on
   Invoices. If its customer is not decided yet, the shipment first waits on Customers
   until you link it (step 8.4). If it cannot be drafted yet (no active price for a SKU, freight cost not
   known yet), the Jobs page says why and the part is drafted by itself once that
   arrives.
2. Open the part, check it against the packing slip, add a note and click **Approve and
   issue**. The invoice is issued exactly as shown and posted to the ledger.
3. Print it (Print view), send it to the retailer, then **Record as printed**.
4. When the money arrives, import the bank statement on Bank (CSV, step 8.6) and
   confirm the proposed match, or use **Record payment** on the invoice. Either way it is
   recorded once.

Check: the invoice shows as paid (or part-paid), Receivables shows the retailer's
balance, and Setup shows "First real invoice: Done".

## 11. Health check (after this deploy and every later one)

1. From your machine (no secrets needed):

   ```sh
   scripts/smoke-deploy.sh https://atlas-api.fly.dev https://<console domain>
   ```

   It checks the API is up and ready, the Shopify webhook refuses a forged request (so
   its secret is set), and the console loads and sends anyone without a session to
   sign-in. Every line must say `ok`.
2. Database up to date: `scripts/go-live/schema-status.sql` in the SQL editor shows no
   `false` row (step 2).
3. Switches, worker and Shopify: the console's Setup page. "Background worker" says when
   the last job finished and whether any job has waited more than ten minutes to be
   picked up; "Shopify connection" says when the last sync succeeded.
4. `fly logs` shows `worker.tick` every minute and no repeated `*_failed` lines.

## 12. Pause, roll back or switch off

- **Stop all business actions at once:** home page → "Pause business actions" with a
  reason. Nothing is issued, recorded, imported or synced, and the pause survives
  restarts. Resume from the same place.
- **Switch one action off:** step 6's `update tool_grants … set enabled = false`.
- **Stop invoicing new shipments:** disable the fulfillment webhook in Shopify. Its
  shipments are then not invoiced, even after it is re-enabled, so prefer pausing.
- **Roll back the API and worker:** `fly releases`, then `fly deploy --image <image of
  the previous release>`. **Roll back the console:** Vercel → Deployments → the previous
  one → Promote to Production (Instant Rollback).
- **Undo a migration:** there is no automatic down migration. Restore the step 1 backup
  only together with the code it matches, and only after stopping both processes
  (`fly scale count api=0 worker=0`).

## Known limits

- The switches in step 6 have no console control yet; they are SQL for now.
- Only unpaid draft orders wait for a decision. An unpaid order from another channel
  (such as the online store) for an undecided customer is treated as a retail order and
  not invoiced.
- An order that is partly paid in Shopify when it ships is not invoiced; invoice the
  balance by hand. Marking an order paid in Shopify after its invoice part is drafted
  does not withdraw the draft: check it before approving.
- An order that shipped partly before the cutoff cannot be invoiced in Atlas for its
  later shipments while freight is charged on the first part (step 9).
- Products are rewritten from Shopify on every sync, so name products and turn variants
  on or off in Shopify, not in Atlas.
- Migrations have no tracking table in the live database; `schema-status.sql` infers
  what is applied from what exists.
- This runbook has been checked against the code and the test environment, not yet
  against a live deploy. Correct it after the first one.
