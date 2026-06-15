-- 0006_control_plane — approvals, audit log, risk tier + decision enums.
-- Shared by every agent (§9). Mutating tool calls route through this layer.

create type risk_tier        as enum ('auto', 'notify', 'approve_required');
create type approval_state   as enum ('pending', 'approved', 'rejected', 'expired');
create type audit_outcome    as enum ('success', 'failure', 'blocked');

-- ---------- approvals ----------
-- Each row represents a single approval gate for an attempted action. Operator (Todd) approves
-- or rejects; the `reason` and `decided_at` fields are the highest-value training signal for
-- autonomy graduation (§9). Phase 0 captures; Phase ∞ graduates.
create table approvals (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete restrict,
  agent_name      text not null,
  action          text not null,                       -- 'issue_invoice', 'send_dunning', etc.
  subject_type    text not null,                       -- 'invoice', 'account', etc.
  subject_id      uuid,
  payload         jsonb not null,                      -- arguments the agent intended to pass
  proposed_summary text,                                -- Claude-written context for the operator
  risk            risk_tier not null,
  state           approval_state not null default 'pending',
  decided_by      text,                                -- operator identifier (email)
  decided_at      timestamptz,
  reason          text,                                -- operator-supplied; training signal
  expires_at      timestamptz,
  created_at      timestamptz not null default now()
);

create index approvals_org_idx on approvals(org_id);
create index approvals_state_idx on approvals(org_id, state);
create index approvals_agent_idx on approvals(org_id, agent_name);

-- ---------- audit_log ----------
-- Immutable record of every mutating action attempted by an agent (whether allowed, blocked,
-- or failed). Insert-only; updates are rejected by policy.
create table audit_log (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete restrict,
  agent_name      text not null,
  action          text not null,
  tool_name       text,                                -- registry tool, if any
  subject_type    text,
  subject_id      uuid,
  approval_id     uuid references approvals(id) on delete set null,
  risk            risk_tier not null,
  outcome         audit_outcome not null,
  detail          jsonb,
  occurred_at     timestamptz not null default now()
);

create index audit_log_org_idx on audit_log(org_id);
create index audit_log_agent_idx on audit_log(org_id, agent_name);
create index audit_log_occurred_idx on audit_log(occurred_at desc);

-- ---------- RLS ----------
alter table approvals enable row level security;
alter table audit_log enable row level security;

create policy approvals_org on approvals
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);

-- audit_log is insert + select only (no updates / deletes) — immutability is policy-enforced.
create policy audit_log_select on audit_log
  for select using (org_id = current_setting('app.org_id', true)::uuid);

create policy audit_log_insert on audit_log
  for insert with check (org_id = current_setting('app.org_id', true)::uuid);
