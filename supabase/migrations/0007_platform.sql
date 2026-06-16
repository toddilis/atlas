-- 0007_platform — event_log (CQRS spine), agents registry, agent_activity, tasks, tool_grants,
-- outbox. The event_log is the append-only source — canonical read-models project from it.

create type agent_kind     as enum ('worker', 'analytical', 'orchestrator');
create type task_state     as enum ('open', 'in_progress', 'blocked', 'done', 'cancelled');
create type outbox_state   as enum ('pending', 'in_flight', 'sent', 'failed', 'dead');

-- ---------- event_log ----------
-- Append-only spine. Every domain change is appended here first; projection workers update
-- the canonical read-models afterwards. Replay = re-run projections from sequence 1.
-- `seq` is a global, gap-free ordering for replay determinism.
create table event_log (
  id              uuid primary key default gen_random_uuid(),
  seq             bigserial not null unique,
  org_id          uuid not null references orgs(id) on delete restrict,
  type            text not null,                          -- 'shopify.fulfillment.created'
  source          text not null,                          -- 'shopify_webhook', 'controller', etc.
  agent_name      text,                                    -- producing agent, when applicable
  subject_type    text,
  subject_id      uuid,
  payload         jsonb not null,
  occurred_at     timestamptz not null default now(),
  appended_at     timestamptz not null default now(),
  idempotency_key text unique                              -- per (source, external id) dedup
);

create index event_log_org_idx on event_log(org_id);
create index event_log_type_idx on event_log(type);
create index event_log_subject_idx on event_log(subject_type, subject_id);
create index event_log_seq_idx on event_log(seq);

-- The log is insert-only; rows must never be updated or deleted in production.
create or replace function block_event_log_mutation() returns trigger
language plpgsql as $$
begin
  raise exception 'event_log is append-only; % blocked', tg_op;
end $$;

create trigger event_log_immutable_update
  before update on event_log
  for each row execute function block_event_log_mutation();

create trigger event_log_immutable_delete
  before delete on event_log
  for each row execute function block_event_log_mutation();

-- ---------- agents (registry) ----------
create table agents (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete restrict,
  name            text not null,                          -- 'controller', 'growth', ...
  domain          text not null,                          -- 'finance', 'growth', ...
  kind            agent_kind not null,
  description     text,
  enabled         boolean not null default true,
  created_at      timestamptz not null default now(),
  unique (org_id, name)
);

create index agents_org_idx on agents(org_id);

-- ---------- agent_activity ----------
-- The narrative stream — what each agent did, in human-readable form. Powers the digest +
-- console activity feed. Distinct from event_log (which is the machine-readable spine).
create table agent_activity (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete restrict,
  agent_name      text not null,
  kind            text not null,                          -- 'observation', 'action', 'decision', 'note'
  summary         text not null,
  subject_type    text,
  subject_id      uuid,
  event_id        uuid references event_log(id) on delete set null,
  detail          jsonb,
  occurred_at     timestamptz not null default now()
);

create index agent_activity_org_idx on agent_activity(org_id);
create index agent_activity_agent_idx on agent_activity(org_id, agent_name);
create index agent_activity_occurred_idx on agent_activity(occurred_at desc);

-- ---------- tasks ----------
-- Thin task state — used by the orchestrator + assistant to track work-in-progress.
create table tasks (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete restrict,
  assigned_agent  text,
  title           text not null,
  state           task_state not null default 'open',
  priority        int not null default 5,
  subject_type    text,
  subject_id      uuid,
  detail          jsonb,
  due_at          timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index tasks_org_idx on tasks(org_id);
create index tasks_state_idx on tasks(org_id, state);

-- ---------- tool_grants ----------
-- Each row authorises one agent to call one tool at a specified risk tier. The control plane
-- consults this table to decide auto / notify / approve_required at call time.
create table tool_grants (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete restrict,
  agent_name      text not null,
  tool_name       text not null,                          -- 'shopify.list_orders', 'stripe.create_invoice'
  risk            risk_tier not null,
  enabled         boolean not null default true,
  granted_at      timestamptz not null default now(),
  unique (org_id, agent_name, tool_name)
);

create index tool_grants_org_idx on tool_grants(org_id);

-- ---------- outbox ----------
-- Transactional outbox for reliable external side-effects (Stripe, email, etc.). The relevant
-- DB write and the outbox row are inserted in the same DB transaction; a worker drains
-- `pending` rows, calls the external API exactly once (via idempotency_key), and updates
-- state. This is what makes the issue_invoice path no-partial-state under failure (§5 ◦ Phase 1).
create table outbox (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete restrict,
  tool_name       text not null,
  action          text not null,
  payload         jsonb not null,
  idempotency_key text not null unique,
  state           outbox_state not null default 'pending',
  attempts        int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error      text,
  result          jsonb,
  related_subject_type text,
  related_subject_id   uuid,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);

create index outbox_org_idx on outbox(org_id);
create index outbox_state_idx on outbox(state, next_attempt_at);

-- ---------- RLS ----------
alter table event_log       enable row level security;
alter table agents          enable row level security;
alter table agent_activity  enable row level security;
alter table tasks           enable row level security;
alter table tool_grants     enable row level security;
alter table outbox          enable row level security;

create policy event_log_select on event_log
  for select using (org_id = current_setting('app.org_id', true)::uuid);
create policy event_log_insert on event_log
  for insert with check (org_id = current_setting('app.org_id', true)::uuid);

create policy agents_org on agents
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy agent_activity_org on agent_activity
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy tasks_org on tasks
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy tool_grants_org on tool_grants
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy outbox_org on outbox
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);
