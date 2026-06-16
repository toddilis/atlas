// Memory consolidation worker — DEFERRED.
//
// When activated, this module will:
//   1. Read recent observations + their source events.
//   2. Cluster + deduplicate via Claude (narration only; no math).
//   3. Upsert semantic_facts (one row per (subject_type, subject_id, predicate)).
//   4. Compute embeddings for observations + semantic_facts via Anthropic (or a self-hosted
//      embedding model), populating the reserved `vector(1536)` columns.
//   5. Build HNSW indexes on those columns for pgvector retrieval.
//
// Until then, agents read observations directly via listObservations(). The interface stub in
// 0008_memory.sql is what locks the contract.

export const CONSOLIDATION_NOTE =
  'Memory consolidation is deferred. Observations write path is live; retrieval is plain SQL.';
