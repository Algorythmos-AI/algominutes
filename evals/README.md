# Eval harness (P1) — retrieval quality gate

The source `evals/queries.jsonl` was **not** ported — it was hand-labelled against the client's private
corpus. This is a **fresh, synthetic** set. Treat **recall@10** as a release gate (the source measured
1.000; hold that bar).

**TODO(evals P1):** generate synthetic recordings (generic meetings — standup, sales call, 1:1, lecture)
via `scripts/fixtures/generate-synthetic-pii.mjs`-style tooling, ingest them, and label the queries below
against the resulting chunks. Wire `services/db-job` `eval-recall` (or a CI job) to score recall@10 on PRs
that touch retrieval (`services/embedder`, `packages/ai`, search routes).
