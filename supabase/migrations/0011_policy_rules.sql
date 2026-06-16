-- 0011_policy_rules — generalised policy engine config.
--
-- Each row is a complete rule set for one (org_id, scope_action) — e.g. the rules that
-- gate every `controller.issue_invoice` call for VICE. When a mutating tool is invoked,
-- the registry looks up the matching enabled row, materialises a `PolicyState` from the
-- canonical Atlas tables, and runs `evaluate(input, state, config)`. The engine returns
-- `allow / block / escalate` with a structured `reasons` array; the registry routes
-- accordingly (auto-execute / record-and-continue / approval-gated).
--
-- The legacy `tool_grants.risk` column stays as a fallback when no policy_rules row
-- matches an action: the registry uses the explicit grant's risk tier exactly as Phase 0
-- did. This makes the engine an opt-in upgrade per action rather than a big-bang refactor.

create table policy_rules (
  id              uuid primary key default gen_random_uuid(),
  org_id          uuid not null references orgs(id) on delete restrict,

  -- The tool-registry action this rule set applies to. Matches the `name` field of a
  -- registered ToolDefinition (e.g. 'controller.issue_invoice', 'stripe.create_invoice').
  scope_action    text not null,

  -- The full RuleConfig — schema lives in src/platform/policy/types.ts. Stored as jsonb
  -- so rule sets can be edited in the future console without a schema migration.
  config          jsonb not null,

  -- Monotonically incremented when an operator updates this rule set. Historical versions
  -- stay around for audit; only the latest (enabled = true) is evaluated.
  version         int not null default 1,

  enabled         boolean not null default true,
  notes           text,                                   -- operator-facing description / change log
  created_at      timestamptz not null default now(),
  created_by      text                                    -- operator email / system identifier
);

create index policy_rules_org_idx on policy_rules(org_id);
create index policy_rules_scope_idx on policy_rules(org_id, scope_action);

-- One enabled current rule set per (org, scope). Historical / disabled versions stay
-- around for audit.
create unique index policy_rules_current_per_scope
  on policy_rules(org_id, scope_action) where enabled = true;

alter table policy_rules enable row level security;

create policy policy_rules_org on policy_rules
  for all using (org_id = current_setting('app.org_id', true)::uuid)
  with check  (org_id = current_setting('app.org_id', true)::uuid);
