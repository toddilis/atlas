-- 0008_memory — observations (write path now), semantic_facts + episodic_summaries (interface
-- stubs, created empty and populated when consolidation ships). Discipline: agents read
-- consolidated memory, NOT raw event_log.

create extension if not exists vector;

create type observation_kind as enum (
  'fact', 'preference', 'pattern', 'anomaly', 'note'
);

-- ---------- observations ----------
-- Typed, agent-written facts referenced to a source event so provenance is preserved.
-- Embedding column is reserved (nullable) — populated by the deferred consolidation worker.
create table observations (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete restrict,
  agent_name      text not null,
  kind            observation_kind not null,
  subject_type    text,                                  -- 'account', 'product', 'invoice', etc.
  subject_id      uuid,
  content         text not null,                          -- natural-language fact
  source_event_id uuid references event_log(id) on delete set null,
  confidence      numeric(4,3) not null default 0.700 check (confidence >= 0 and confidence <= 1),
  embedding       vector(1536),                           -- reserved; populated by consolidation
  metadata        jsonb,
  occurred_at     timestamptz not null default now(),
  superseded_by   uuid references observations(id) on delete set null
);

create index observations_org_idx on observations(org_id);
create index observations_agent_idx on observations(org_id, agent_name);
create index observations_subject_idx on observations(subject_type, subject_id);
create index observations_kind_idx on observations(org_id, kind);
-- HNSW index on the embedding column is deferred until consolidation populates it.

-- ---------- semantic_facts (interface stub) ----------
-- Populated by the deferred consolidation worker. Empty in Phase 0; the contract is locked so
-- nothing is retrofitted later.
create table semantic_facts (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete restrict,
  subject_type    text not null,
  subject_id      uuid not null,
  predicate       text not null,                          -- 'pays_late_by_days', 'prefers_terms', etc.
  value           jsonb not null,
  confidence      numeric(4,3) not null check (confidence >= 0 and confidence <= 1),
  evidence_count  int not null default 1,
  derived_from    uuid[],                                  -- observation ids
  embedding       vector(1536),
  first_seen_at   timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  superseded_by   uuid references semantic_facts(id) on delete set null,
  unique (org_id, subject_type, subject_id, predicate)
);

create index semantic_facts_org_idx on semantic_facts(org_id);
create index semantic_facts_subject_idx on semantic_facts(subject_type, subject_id);

-- ---------- episodic_summaries (interface stub) ----------
create table episodic_summaries (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete restrict,
  agent_name      text not null,
  window_start    timestamptz not null,
  window_end      timestamptz not null,
  summary         text not null,
  highlights      jsonb,
  derived_from    uuid[],                                  -- event ids
  embedding       vector(1536),
  created_at      timestamptz not null default now()
);

create index episodic_summaries_org_idx on episodic_summaries(org_id);
create index episodic_summaries_window_idx on episodic_summaries(window_start desc, window_end desc);

-- ---------- RLS ----------
alter table observations         enable row level security;
alter table semantic_facts       enable row level security;
alter table episodic_summaries   enable row level security;

create policy observations_org on observations
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy semantic_facts_org on semantic_facts
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

create policy episodic_summaries_org on episodic_summaries
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);
