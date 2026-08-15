# Decision log — AlgoMinutes

One line of reasoning per decision. Newest first within each phase. This file is the durable record of
choices made during the automated A2/A3 run so they are auditable from the git log.

## DECIDED — A9.3 & A6.3 (2026-08-16)

- **A9.3 — REVERSE TRIAL** (not freemium, not a plain trial). Day 1–7: full features, **no card**, on web
  and mobile. After day 7: account drops to a thin **free floor** (habit-alive, not real work). **Pro
  A$14.99/mo**, annual ≈ two months free (**A$149.90/yr**). Rationale: reverse trials convert ~24% median
  vs ~4.5% freemium / ~14% opt-in trial; a perpetual free tier + a trial cancel out; competitors' generous
  free tiers (Otter 300 min/mo, Fathom unlimited) mean a free tier is not a differentiator for an unbranded
  product — the trial is. **`FREE_FLOOR_MINUTES` is DELIBERATELY UNSET** (config, loud TODO(A9-pricing)):
  it depends on blended COGS/min which A11 measures; shipping a guessed number risks an unbounded bill, so
  it **fails safe to 0 metered minutes until set**. Pro included minutes are config too.
- **A6.3 — GUEST MODE with anonymous→permanent upgrade.** No card + full features for 7 days means a user
  records and sees a summary before any account exists. Entitlement/ledger already key off a resolved uid
  that works for anonymous (Firebase anonymous auth) or permanent accounts — and Firebase
  `linkWithCredential` PRESERVES the uid, so upgrade loses no data and does not restart the trial. Prompt
  for the account **at the moment of value (after the first summary)**, never at launch.

  ⚠️ **Fragility flagged (see BLOCKERS):** no-account-for-7-days + anonymous means a reinstall with a fresh
  anonymous uid can restart the trial. Server keys the trial to uid; binding it to a durable device signal
  (iOS DeviceCheck/App Attest, Android Play Integrity) to stop reinstall-restart is a separate anti-abuse
  decision — a `trial_device_hash` seam column exists but is not enforced.

## A9.4 — App Review Guideline 3.1.3 (checked 2026-08-16)

- **Current rule:** external-purchase links / web-pricing CTAs are allowed **only on the US storefront**
  (no entitlement required there since 2025); other storefronts remain restricted, misleading price
  comparisons are prohibited, and a button that visually mimics an IAP button triggers the full disclosure
  flow. **Decision:** the **iOS paywall shows StoreKit pricing ONLY and never references web pricing**
  (AlgoMinutes ships globally from AU; the permissive rule is US-only). Revisit per-storefront if we later
  want to surface the cheaper web rail on iOS. Flagged to you rather than assumed.

## A7 — Reliability & async UX

- **A7.1 offline capture was already substantially built (§5); extended, not rewritten.** Added a durable
  per-recording upload state (`recorded→uploading→processing→ready→failed` + byte offset) to the
  `RecordingStore` sidecar and surfaced it in `PendingRecordingsView`. Local-first write, recovery-on-relaunch,
  and play-before-upload already held.
- **A7.2 resumable upload — additive new transport, NOT a §5 rewrite.** The inherited `UploadService`
  (Firebase `putFile`) does not do URLSession background transfers and restarts from byte 0 across launches
  — which A7.2 (the phase) explicitly requires. Rather than rewrite the working uploader, added a NEW
  `BackgroundUploadService` (URLSession background, chunked, persisted byte-offset, resume-after-reboot)
  against a new server **upload-session contract** (`POST /v1/uploads` → GCS resumable session), wired as
  the resumable path but **gated OFF by default pending on-device verification** (can't build/test here);
  Firebase `putFile` stays as the working fallback. This is the case for the change, made here per §5.
  Wi-Fi-only is a P1 settings toggle. **Android upload is B2** — it consumes the same upload-session contract.
- **A7.3 notifications — `services/notifier` is a NEW service.** Operating cost (§3.3): one async Cloud Run
  service (scale-to-zero, no idle floor) + the `notify` Cloud Tasks queue + one dashboard/alert; cost driver
  is FCM fan-out volume (cheap). Push permission is requested only AFTER the first recording (never at
  launch). Real APNs/FCM device registration is `TODO(A4-apple)` (needs the iOS Firebase app). Local
  notification is the fallback when push is declined; taps deep-link via `algominutes://note/<id>`.
- **A7.4 failure/quota integrity.** Refund-on-failure is a **reversal row** in `usage_ledger` (never a
  delete), appended on a worker's FINAL attempt. **Metering happens at ingest in the api process route**
  (before transcode is queued — A9.2, so we never pay for STT on over-quota work); the workers do the
  *refund*. **Embedder failure does NOT refund and does NOT notify** — the note is still readable without
  embeddings, so it's only dead-lettered. DLQ = a `dead_letter` table (Cloud Tasks has no native DLQ) with
  an admin view; workers write it on final attempt.

## A9 — Revenue layer (schema groundwork only)

- **Schema + repo only** (per instruction) — no StoreKit / Play / Stripe / paywall UI (those depend on the
  OPEN decisions above). `plans` + `usage_ledger` added; `subscriptions` extended with `source` (dual-rail
  seam, A9.4) + `trial_end` (A9.3 seam). Plan minute quotas are **config-authoritative**
  (`@algominutes/contracts` `PLAN_MONTHLY_INCLUDED_MINUTES`), mirrored by the `plans` table.
- **Entitlement is server-side** (`assertCanMeter`/`resolveEntitlement` over the ledger) — never trust the
  client; the `GET /v1/entitlement` endpoint exposes it read-only.

## A5 — Rename to AlgoMinutes

- **Renamed class-by-class, one commit per class** (iOS, Android, web+services+packages+.claude, docs) —
  no blind global sed, since `wassup` appears in bundle ids / package paths where a careless replace breaks
  signing/build silently. Each class independently verified (xcodegen for iOS, `google-services.json`
  package_name match for Android, grep-clean + invariants for web/services).
- **iOS:** `com.wassup.meeting`→`com.algorythmos.algominutes` (+ `.BroadcastExtension`/`.BroadcastExtensionSetupUI`),
  dir `Wassup/`→`AlgoMinutes/`, `WassupApp.swift`→`AlgoMinutesApp.swift`, keychain group + App Group →
  `…algominutes` / `group.com.algorythmos.algominutes`, module name `Wassup`→`AlgoMinutes`. `project.yml`
  only; xcodegen regenerates.
- **Android:** package tree `com/wassup/meeting`→`com/algorythmos/algominutes`, namespace+applicationId,
  action constants, app_name, channel ids, notification icon. `google-services.json` was already registered
  against `com.algorythmos.algominutes` — verified match, left untouched.
- **Backend domains:** `wassup-meeting.web.app` → `api.algominutes.com` (API) / `algominutes.com` (site) in
  iOS APIClient/LoginView and web `apiUrl.ts` (env-driven, `VITE_API_BASE_URL` wins). Domains not yet
  confirmed live — `TODO(A9-infra)`.
- **GCP project-id refs** in service deploy configs → `${GCP_PROJECT}` / `algominutes-dev` placeholders, not
  a hardcoded real id (per-env at deploy).
- **Provenance docs deliberately keep the source-repo name** (`skalaliya/wasssup-meeting`) and client
  identifiers being replaced — the verify grep's only remaining hits are those 6 docs; that is legitimate.

## A6.5 — Design system

- **Provisional AlgoMinutes palette + type scale** authored once in `packages/tokens/tokens.json` and applied
  to web (`index.css` `@theme`), iOS `Theme.swift`, and a new Android Compose theme (B2 foundation). Brand
  accent = indigo `#5B67F0` (distinct from the client's Apple-blue `#0A84FF`), refined dark neutral ramp +
  a light ramp, status colours, modular type scale, a11y baselines. **Kept the app's dark-first aesthetic**
  (a full light-mode wiring is a follow-up; the light ramp exists in tokens).
- **Client brand fonts (Rajdhani/Titillium) dropped** for a system font stack; **final hue, logo/wordmark
  art, and typeface are `TODO(brand)`** — no artwork generated, per instruction.

## A6.9 — Accessibility

- **Applied the safe, high-confidence fixes** (VoiceOver/ARIA labels on icon-only controls, one
  Dynamic-Type fix, 10 touch-targets to 44pt/px across iOS + web) and **flagged contrast/layout for design**
  rather than auto-changing brand tokens. Report: `docs/audits/A6.9-ACCESSIBILITY.md`.
- **Contrast recommendation (needs brand sign-off, tied to the TODO(brand) hue):** the provisional accent
  `#5B67F0` is 4.34:1 on the dark bg — **fine for large text/fills but below AA (4.5:1) for normal-size
  text/links.** Recommended fix when the brand hue is set: reserve the accent for large text/fills and add
  an `accentText` token (a lighter indigo, ~`#8B93F7`, ≥4.5:1 on `#0B0B10`); bump `placeholder`
  (`#5A5D6E`, 3.02:1) to ~`#6E7183`. Not applied now — the final palette is a brand decision.
- **Android TalkBack + Compose a11y deferred to B2** (no Compose app yet).

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
