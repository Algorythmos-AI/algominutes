# Decision log — AlgoMinutes

One line of reasoning per decision. Newest first within each phase. This file is the durable record of
choices made during the automated A2/A3 run so they are auditable from the git log.

## A4 — Provision infrastructure (non-Apple)

- **Nothing was provisioned live** — the automated session's gcloud identity (`skalaliya@gmail.com`) has
  no access to `algominutes-staging`/`prod` (owned by `gcp-admin@algorythmos.com`). I did not authenticate
  as another account. Safe default: author everything apply-ready and hand the apply to a `gcp-admin` shell.
- **Infrastructure as Terraform, not imperative gcloud** (BUILD-PLAN §4.3). Idempotent, reviewable, one
  `terraform apply` per env. Structure: a reusable `modules/environment` + thin `envs/{staging,prod}` callers.
- **Cloud Run services are NOT in Terraform.** Their runtime service accounts, IAM, VPC connector and
  Artifact Registry are; the service *deploys* (build → push → deploy) are per-service in A11 (§3.3 "own
  deploy"). Terraform provisions the durable infra around them.
- **VPC + private IP + serverless connector included** — required by the invariant "Vertex AI only from
  Cloud Run behind the VPC connector; the public Gemini client does not work from there." Cloud SQL is
  private-IP only.
- **Staging tier differences** (mirror prod architecture at the smallest viable tier): Cloud SQL
  `db-f1-micro`/10GB, PITR off, `deletion_protection` off, 7-day recordings-bucket lifecycle, Firestore
  deletion allowed. **Prod:** dedicated `db-custom-1-3840`/20GB, PITR on, `deletion_protection` on, no
  recordings lifecycle. Both ZONAL to start (REGIONAL HA is a later prod hardening).
- **§4.6 circuit breaker fails OPEN on a meter-read error** — a broken cost meter logs loudly but does not
  halt the whole product; the sustained-outage backstop is the budget alerts + monitoring. Trip on a real
  over-cap read is hard (non-retryable). The spend reader is a stub (returns 0) until A9 wires
  usage_ledger/COGS, so the breaker is present-and-wired but inert now.
- **Budgets not managed in Terraform** — they already exist (INFRASTRUCTURE §4.4); recreating would
  conflict. The prod-budget re-scope stays a manual open item.
- **Firebase configs regenerated per env via the CLI** (runbook step 4), never copied from the client
  project, and never committed (git-ignored).
- **Staging is provisioned (15 Aug 2026).** `terraform apply` on `algominutes-staging` succeeded — 111
  resources live. Firebase enabled (Blaze), Google sign-in on, Web + Android apps registered; iOS app not
  registered (pending Apple Team ID). Prod is authored but not yet applied.
- **Web Firebase config lives in `apps/web/.env`** (git-ignored), read via `import.meta.env.VITE_FIREBASE_*`
  in `firebase.ts` and `VITE_API_BASE_URL` in `apiUrl.ts`. All 8 vars align with `.env.example` — no
  missing/extra. The apiKey is a public domain-restricted client key but is kept out of git and out of
  INFRASTRUCTURE.md; `.env` is the single place for it. Per-env values never shared (prod regenerates).
- **Firebase Analytics is deliberately OFF in the web client.** No `getAnalytics()` call exists; the
  config's `measurementId` is present but unused, so no analytics data is collected. Turning it on is an
  A10 decision (privacy policy + store Data Safety), not a default. Recorded so it stays a choice.
- **Cloud SQL `edition` pinned to `ENTERPRISE` (both envs), set in tfvars.** The first staging apply failed
  — Google now defaults new Postgres instances to `ENTERPRISE_PLUS`, which rejects shared-core tiers
  (`db-f1-micro`). Added a `db_edition` module variable (default `ENTERPRISE`, validated to the two allowed
  values), wired into `google_sql_database_instance.pg.settings.edition`, exposed as a root var in each env
  and set to `ENTERPRISE` in both tfvars (not hardcoded in the module). Prod's `db-custom-1-3840` is valid
  on either edition; `ENTERPRISE` is chosen to keep both envs consistent and avoid the pricier
  ENTERPRISE_PLUS default. Everything else in the first apply succeeded; re-apply creates only the SQL
  instance/DB/user.

## A6 — Generalise the product (credential-free parts)

- **A6.1 templates:** removed the client `clinical` template; kept `general` + `actions_only`; added
  `standup`, `interview`, `sales_call`, `lecture`, `one_on_one`, `board_meeting`, `client_meeting`. Every
  template reuses the flat `BASE_SCHEMA` (gist/actionItems/keyDecisions) — the structured-output invariant
  is preserved, not loosened (a template that added fields would be silently dropped by the tables, the
  Swift model, and the gemini-1.5-flash fallback). Canonical set in `@algominutes/ai`; mirrored to
  `packages/contracts` (enum + `SUMMARY_TEMPLATES` + openapi) and the iOS enum/tests. Web renders from the
  contract; Android is B2. This is a three-client contract change — openapi/model regen is deferred (no deps).
- **A6.2 recording cap:** replaced the hardcoded 2h cap + "Slater staff meetings" justification with a
  named, plan-derived config (`RECORDING_LIMITS`/`DEFAULT_MAX_RECORDING_SECONDS`/`maxRecordingSecondsForPlan`)
  in `@algominutes/contracts`. Kept 2h as the default-tier value to avoid a cost-affecting behaviour change;
  per-plan values are TODO(A9). Web imports it; iOS mirrors the constant (Swift can't import the TS const).
- **A6.7 strings:** stood up the string catalog (`packages/tokens/strings/en.json`, 57 strings) + typed
  `t()`/`strings` accessor now so i18n is not a three-client retrofit. **Template labels/blurbs are NOT
  duplicated in tokens** — they stay with the template set in `@algominutes/contracts`. iOS/Android consume
  generated `Localizable.strings`/`strings.xml` from the catalog; that codegen (json→platform) is TODO,
  same pattern as contracts models. The exhaustive per-file migration of every remaining hardcoded string
  is a tracked follow-up — the infra + a real shared catalog + web wiring are in place.
- **A6.4 / A6.6 delivered as audits** (`docs/audits/`), not implementation — the user scoped these as the
  audit passes. Onboarding/sample-note/permission-explainer building executes from the A6.4 audit later.
- **A6.6 safe copy fixes applied now** (the rest await A5/A8): (V1) the web "Record Online Meeting" card is
  filtered out on `platform === 'web'` — the read-only web client can't capture system audio, so it must
  not advertise it (ADR 0002); (V2) the web alert no longer claims online recording is "iOS only" (Android
  does it too); (V3) the iOS login tagline "…chat with every meeting" → "Record, transcribe, and get the
  minutes." (iOS ships mic-only). "Wassup Doc" naming left for A5.
- **iOS broadcast extension stays re-homed but MUST NOT ship unwired** (A6.6 N1). It is bundled
  (`apps/ios/BroadcastExtension`) yet no in-app UI triggers it (no `RPSystemBroadcastPickerView`), which a
  reviewer will question. Safe default: keep it in the repo (§5 protected asset); before the iOS
  submission build, EITHER wire it (`RPSystemBroadcastPickerView` + honest capture copy + the A4 App Group)
  OR exclude it from that build. Recorded in BLOCKERS — a decision for you, not resolved here (needs A4).

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
- **Android A3 scope = audio layer + interface only.** The full native Compose app (auth, UI, upload,
  paywall) is Track B / B2. A3 ports the recorder cores + a Capacitor-free interface so B2 starts from
  the hard part. `apps/android` is intentionally not a buildable app yet.
- **All of source `shared/` consolidated into `@algominutes/ai`** (incl. `pg-query`, `storage-paths`,
  `logger`, `cloud-tasks`), not split across db/ai. Reason: services resolve `shared/` at runtime via a
  flat `sharedRequire(name)`; one resolution root (`@algominutes/ai/<name>`) preserves that with a
  minimal edit instead of a per-name package map. `packages/db` = repo layer + migrations only.
- **Service Dockerfiles vendor the workspace packages** (`COPY packages/ai|db → node_modules/@algominutes/*`)
  replacing `COPY shared ./shared`. Full npm-workspaces build wiring is a TODO(build) for A11.
- **`services/api` runs under `tsx`** (no build step) because it imports `@algominutes/db` TypeScript
  source; mirrors the source's own `tsx server.ts`. A compiled build is an A11 concern.
- **API surface uses clean `/v1/...` names with the body contract preserved** (noteId/workspaceId in the
  JSON body), NOT `/v1/notes/:id` path params — path params would change what clients send.
- **Web keeps client-side extraction (pdfjs/mammoth/tesseract) for now**; switching the web to call
  `services/extractor` is a follow-up. A3's P0 was that the shared service exists.
- **Web Capacitor calls resolved via web-safe shims** (`apps/web/src/lib/native-shim/*`) rather than
  deleting App.tsx's native branches now — full web de-Capacitor + generalisation is A8. This keeps the
  repo free of any `@capacitor` dependency while being honest that A8 work remains.
- **Web Firebase config reads Vite env vars** (`apps/web/.env.example`) instead of importing the
  committed per-project JSON (which is git-ignored / regenerated at A4).
- **Branding + design tokens deferred to A6.5, i18n strings to A6.7.** iOS/Android brand assets and the
  web `@theme` block are kept as neutral placeholders with `TODO(brand)` so the apps still render; real
  values come from `@algominutes/tokens`.
- **Firestore `onNoteDeleted` stays a Firebase trigger** (genuine `onDocumentDeleted`); everything else
  HTTP moves to `services/api`. The six extra HTTP handlers in `functions/index.js`
  (processIntelligence, regenerateSummary, shareCreate, shareRevoke, noteFeedback, clientError) are being
  ported into `services/api` to complete the one-surface goal (§3.1).

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
