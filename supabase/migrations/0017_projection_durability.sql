-- 0017_projection_durability — Phase 2.5 PR-J.
--
-- Review finding (HIGH): projection failures were logged and swallowed. appendEvent caught
-- dispatch errors and returned success, webhooks 200-OK'd regardless, and replay() threw
-- 'not implemented' — so a failed projection (e.g. the fulfillment-before-order-sync race
-- the webhook code explicitly anticipates) was lost silently and permanently.
--
-- Mechanism: every event_log row gets a projection-state row, created by trigger IN THE SAME
-- TRANSACTION as the append — there is no window where an event exists untracked. Dispatch
-- marks the row 'projected' on success or 'failed' (+ error) on failure; a process crash
-- between append and dispatch leaves it 'pending', which is equally visible. replay() drains
-- everything not 'projected' in seq order. Rows that exhaust automatic attempts go 'dead'
-- and surface on the operator dashboard (needs-attention, PR-S) — dead rows are still
-- retried by explicit provider redelivery, just not by the automatic replay loop.
--
-- Granularity is per-event, not per-projector: projectors are idempotent (canonical upserts
-- + event dedup + the dedup keys added below), so re-running all of an event's projectors
-- after a partial failure is safe and much simpler to reason about.

create type projection_state as enum ('pending', 'projected', 'failed', 'dead');

create table event_projections (
  event_id     uuid primary key references event_log(id) on delete restrict,
  org_id       uuid not null references orgs(id) on delete restrict,
  seq          bigint not null,
  state        projection_state not null default 'pending',
  attempts     int not null default 0,
  last_error   text,
  updated_at   timestamptz not null default now()
);

-- The replay queue: everything not yet projected, drained in seq order.
create index event_projections_outstanding_idx
  on event_projections (seq)
  where state <> 'projected';
create index event_projections_org_idx on event_projections (org_id);

create or replace function event_log_track_projection() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  insert into event_projections (event_id, org_id, seq)
  values (new.id, new.org_id, new.seq);
  return new;
end $$;

create trigger event_log_track_projection
  after insert on event_log
  for each row execute function event_log_track_projection();

-- Backfill: rows appended before this migration are marked 'projected'. Their true
-- projection state is unknowable after the fact; the system was verified converged at the
-- Phase 0/1 checkpoints, and marking them outstanding would re-dispatch the entire history
-- on the first replay for no benefit.
insert into event_projections (event_id, org_id, seq, state)
select id, org_id, seq, 'projected' from event_log
on conflict (event_id) do nothing;

-- ---------- narrative-stream dedup ----------
-- Re-dispatch is only safe end-to-end if every write a projector makes is idempotent.
-- Canonical rows already upsert on external ids; agent_activity and observations were plain
-- inserts (review finding H2: a retry duplicated the narrative + memory streams). Writers
-- may now pass a dedup key; a conflict is treated as an already-recorded no-op.

alter table agent_activity add column dedup_key text;
create unique index agent_activity_dedup_idx
  on agent_activity (org_id, dedup_key) where dedup_key is not null;

alter table observations add column dedup_key text;
create unique index observations_dedup_idx
  on observations (org_id, dedup_key) where dedup_key is not null;

-- ---------- RLS ----------
alter table event_projections enable row level security;

create policy event_projections_org on event_projections
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);
