// Autonomy graduation — Phase 0 captures the signal; graduation logic is deferred.
//
// Every approve/reject decision Todd makes is the highest-value training signal we have. The
// raw signal already lives in `approvals` (state + reason + decided_at). When the consolidation
// worker ships, it will project those rows into semantic_facts that the control plane reads
// when deciding the risk tier for the next attempt of the same (agent, action).
//
// Nothing here yet — recording IS the signal. The signal lives in `approvals`.

export const AUTONOMY_NOTE =
  'Autonomy graduation is deferred. Approval signal is captured in `approvals`.';
