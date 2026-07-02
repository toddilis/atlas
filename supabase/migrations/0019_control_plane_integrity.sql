-- 0019_control_plane_integrity — Phase 2.5 PR-L.
--
-- Review findings:
--   MED-HIGH · audit_log's "immutability" was only the absence of UPDATE/DELETE RLS
--     policies — and the app connects as service_role, which bypasses RLS entirely. The
--     app credential could rewrite audit history freely, while event_log (described the
--     same way) had real triggers. This gives audit_log the same mechanism.
--   MED · approvals were not single-use and expiry was decorative: executeApproved only
--     checked state='approved', so one approval could execute a tool twice, and nothing
--     ever enforced expires_at.
--
-- The single-use guard is `executed_at` + a compare-and-swap (consume, then execute), done
-- from the app layer; the enum keeps its four decision states because "executed" is a fact
-- about the approved action, not a fifth decision.

-- ---------- audit_log immutability (same mechanism as event_log, 0007) ----------

create or replace function block_audit_log_mutation() returns trigger
language plpgsql
set search_path = pg_catalog, public
as $$
begin
  raise exception 'audit_log is append-only; % blocked', tg_op;
end $$;

create trigger audit_log_immutable_update
  before update on audit_log
  for each row execute function block_audit_log_mutation();

create trigger audit_log_immutable_delete
  before delete on audit_log
  for each row execute function block_audit_log_mutation();

-- ---------- approvals single-use ----------

alter table approvals add column executed_at timestamptz;

comment on column approvals.executed_at is
  'Stamped by the compare-and-swap in consumeApproval() before the approved tool runs. '
  'Null = not yet executed. An approval is spent by execution (even a failed one): '
  'partial external side-effects must not auto-retry without a fresh operator decision.';

create index approvals_executable_idx
  on approvals (org_id) where state = 'approved' and executed_at is null;
