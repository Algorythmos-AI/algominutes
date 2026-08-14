# Decision log — AlgoMinutes

One line of reasoning per decision. Newest first within each phase. This file is the durable record of
choices made during the automated A2/A3 run so they are auditable from the git log.

## A3 — Port, consolidate, contract

- **db-job folds into a scheduled Cloud Run job, not `api` (§3.2).** Its handlers (`eval-recall`,
  `debug-corpus`, `verify-phase-0`, `backfill-pr-d`) are batch/ops work, not user-request work; putting
  them behind the sync `api` surface would mix scaling profiles. Ported to `services/db-job` as a job
  entrypoint; client-specific backfill payloads dropped. Reversible: can be merged into `api` later.
- **Functions handlers consolidated into `services/api` as `/v1` routes (§3.1).** `note-read`,
  `export-note`, `search-and-chat`, `shared-note`, `delete-account` become Express routers under one
  auth path + one CORS config. Firebase Functions retained ONLY for genuine triggers (auth/Firestore) —
  none of the five was trigger-bound, so all five move. One HTTP surface achieved.
- **API is versioned from day one under `/v1` with a required `X-AlgoMinutes-Client` version header.**
  Unsupported clients get a friendly 426 "please update", never a 500. iOS/web ship before Android, so
  old builds must keep working — the version gate is additive, never breaking within `/v1`.
- **Contracts authored once in `packages/contracts` (zod) → OpenAPI → generated Swift/Kotlin models.**
  Never hand-write three copies. Generation is scripted so a contract change is a single-source edit.
- **`services/extractor` is a new Node service** wrapping `pdfjs-dist` / `mammoth` / `tesseract.js`
  (all permissive) + YouTube transcript extraction (ported from `transcoder/src/youtube.js`). Kills the
  JS-only client dependency so iOS/Android/web share one extraction implementation.
- **Token rename (wassup→algominutes) is NOT done in A3.** A3 is a structural port; the global rename is
  A5. Ported code still contains `wassup`/`com.wassup.meeting` until A5 runs — expected per the plan.
- **Redaction test fixtures use inline `# gitleaks:allow`, not a path allowlist.** Keeps `.gitleaks.toml`
  allowlist empty (§4.2) while letting synthetic fake secrets exist in tests without failing the gate.
- **ReplayKit broadcast extension re-homed into `apps/ios/BroadcastExtension` (+ SetupUI).** It lived in
  the Capacitor `ios/` target that we drop; the Swift logic is a §5 protected asset and was moved, not
  deleted (carry-forward from A1).
- **Android Capacitor plugin bridges replaced by a direct Kotlin interface** (`RecorderInterface`). The
  MediaProjection/ForegroundService cores (`RecordingService`, `BroadcastRecordingService`) were ported
  unchanged (§5 protected); only the `*Plugin.kt` Capacitor glue was replaced.

## A2 — Repository foundation

- **`main` is not pushed and branch protection is not enabled during this automated run.** Reasoning:
  branch protection with required PRs would block the per-unit commits this run makes, and the first
  push is an outward action better taken by a human after reviewing the full port via `git log` — also
  the source-side Gemini-key rotation (EXTRACTION-AUDIT §5) is still pending. Remote is configured
  locally; push + protection are listed for the human in BLOCKERS. Reversible: nothing left the machine.
- **npm workspaces (no Turborepo yet).** §3.4 says add Turborepo only if build times justify it; they
  don't yet. Workspaces cover `packages/*`, `services/*`, `apps/web`; native `apps/ios` and
  `apps/android` are not npm workspaces.
- **`.gitleaks.toml` ships with an empty allowlist**; Firebase per-project configs are git-ignored and
  regenerated per environment (A4), so nothing needs allowlisting.
- **Proprietary `LICENSE`** (all rights reserved, © 2026 Algorythmos Pty Ltd) — the source had none; not
  carried forward.
