# Claude Code — build **AlgoMinutes**

A general-purpose AI meeting recorder: **native iOS**, **native Android**, phones and tablets, plus a
**React web app**. Published by **Algorythmos Pty Ltd**, built on the platform in `wasssup-meeting`.

---

## 0. Where things live

| Thing | Location |
|---|---|
| **Target repo** | `github.com/Algorythmos-AI/algominutes` |
| **Remote** | `https://github.com/Algorythmos-AI/algominutes.git` |
| **Local working copy** | `~/algominutes` — run from here |
| **Source repo (READ-ONLY)** | a **separate** full clone of `wasssup-meeting`, e.g. `~/src/wasssup-meeting` |

⚠️ **Before anything else, confirm two things and stop if either fails:**

1. The GitHub repo is named **`algominutes`**, all lowercase. It was created as `Algominutes`. If it
   still has a capital A, tell me to rename it in Settings → General before you push. Do not proceed
   with a mixed-case remote
2. The source clone is **outside** `~/algominutes`, is a full clone
   (`git rev-parse --is-shallow-repository` returns false), and has no write remote configured

**Never commit to, push to, or modify the source repo. It is read-only for the entire build.**

---

## 1. Mission

Ship a paid, general-audience meeting recorder, fast, then improve it in versions. Record a meeting,
transcribe it with speaker labels, produce structured minutes with decisions and action items. Anyone
with meetings is the user. Subscription revenue from the first release.

**Owner:** Algorythmos Pty Ltd, ACN 701 006 626, ABN 22 701 006 626, Sydney NSW.

**Bias to shipping.** Every item is priority-tagged. When something runs long, cut scope rather than
delay the release — and tell me what you cut. A smaller shipped product beats a larger unshipped one.

### Naming and casing — follow exactly

The wordmark is **AlgoMinutes** — bicapitalised, one word, no space, no hyphen.

| Context | Form | Example |
|---|---|---|
| Wordmark, UI, store listings, marketing, docs | `AlgoMinutes` | "AlgoMinutes, by Algorythmos" |
| App display name, both stores | `AlgoMinutes` | `CFBundleDisplayName`, `app_name` |
| Xcode project, target, scheme, Swift types | `AlgoMinutes` | `AlgoMinutesApp.swift` |
| **Bundle ID / applicationId** | **lowercase** | `com.algorythmos.algominutes` |
| **Android package path** | **lowercase** | `com/algorythmos/algominutes/` |
| **GitHub repo, npm packages, services, DB, buckets, queues** | **lowercase** | `algominutes`, `algominutes-transcoder` |
| Domain | lowercase | `algominutes.com`, `api.algominutes.com` |

**Never put capitals in a bundle identifier, an Android package path, a repo name or an npm name.**
`Algominutes` or `algoMinutes` in any user-visible string is a bug.

### Client architecture — decided, do not re-litigate

| Surface | Stack | Role |
|---|---|---|
| **iOS** — iPhone + iPad | Native SwiftUI | Capture + review |
| **Android** — phone + tablet | Native Kotlin + Jetpack Compose | Capture + review |
| **Web** | React 19 + Vite + Tailwind | Review, manage, pay. **Does not capture** |

**Capacitor is removed entirely.** Delete the Capacitor `ios/` target; do not port
`capacitor.config.ts`; strip every `@capacitor/*` and `@capacitor-firebase/*` dependency. The React
app in `src/` becomes **the web client**. For mobile it is a **reference specification**, not shipped
code. **The rule: mobile records, web reads.**

---

## 2. Release strategy

Two tracks in parallel. **Track A is the critical path to revenue and must never be blocked by Track B.**

| Track | Contents | Gating |
|---|---|---|
| **A — Launch** | Foundation → web app → iOS app → submit | Nothing waits on Android |
| **B — Android** | Native Kotlin client, built alongside | Ships as v1.1 |

The web client already exists as React and the iOS app is already on TestFlight. Android native does
not exist at all. Holding web and iOS for Android parity costs months of revenue for no benefit.

| Version | Surfaces | Contents |
|---|---|---|
| **v1.0** | Web + iOS | Everything **P0** |
| **v1.1** | + Android | Android client, plus **P1** |
| **v1.2** | All three | **P2** |
| **later** | All three | **P3** |

**P0** blocks v1.0 — cannot submit or charge without it. **P1** is launch quality; ship in v1.0 if
ready, else v1.1; its absence shows in reviews. **P2** is fast follow. **P3** is a deliberate deferral,
recorded so it is a choice and not an oversight.

**When a P0 item threatens the release, bring me the tradeoff. Do not silently extend.**

---

## 3. Backend architecture — services, not a distributed mess

The instruction is **not** to build a monolith, and **not** to shard everything into microservices.
Split where workloads genuinely differ; keep one coherent synchronous surface. This is what the source
already does for the pipeline, and it is the right shape.

### 3.1 A loophole to fix first · **P0**

The source has **two HTTP surfaces doing overlapping work**: Express `server.ts` *and* Firebase
Functions (`note-read.cjs`, `export-note.cjs`, `search-and-chat.cjs`, `shared-note.cjs`,
`delete-account.cjs`). Two auth paths, two CORS configurations, two deploy pipelines, two places a bug
can hide — about to be consumed by three clients.

**Consolidate to one API service.** Port the Functions handlers into the `api` service as routes,
preserving behaviour exactly. Keep Functions only where a Firebase trigger is genuinely required
(auth triggers, Firestore triggers). Report anything you cannot move and why.

### 3.2 Service topology

| Service | Type | Responsibility | Why separate |
|---|---|---|---|
| `api` | Cloud Run, sync | HTTP edge for all three clients: auth, notes CRUD, search, chat, export, entitlement checks, admin | One surface, one auth path. Scales on request volume |
| `transcoder` | Cloud Run, async | Audio → chunks → STT v2 | Long timeouts, heavy CPU, completely different scaling curve |
| `summarizer` | Cloud Run, async | Transcript → structured summary via Vertex | Model latency; retries and cost profile of its own |
| `embedder` | Cloud Run, async | Chunks → pgvector | Batch-shaped work |
| `extractor` | Cloud Run, async | **NEW.** Document text extraction: PDF, DOCX, images/OCR, YouTube | Replaces the JS-only pipeline (`pdfjs-dist`, `mammoth`, `tesseract.js`) that cannot survive into Swift or Kotlin. **One implementation, three clients** |
| `billing` | Cloud Run, sync | Store receipt validation, Stripe and store webhooks, entitlement writes | Different security posture, public webhook endpoints, must not share a scaling pool with user traffic |
| `notifier` | Cloud Run, async | FCM fan-out, email | Fan-out and third-party latency |

`db-job` from the source folds into `api` or a scheduled job — decide and report.

### 3.3 Rules that keep this clean · **P0**

- **One Postgres, owned by the schema, accessed only through the shared repo package.** Do not split
  the database. Do not let any service write tables it does not own. The existing `notes-repo`
  invariant is the model — extend it, never bypass it
- **Async between services only** — Cloud Tasks or Pub/Sub. **No synchronous service-to-service calls
  in a user request path.** If `api` needs a worker result, it reads state from Postgres
- **Every async handler is idempotent** — Cloud Tasks replay is normal, not exceptional. Upserts and
  `ON CONFLICT`, per the existing invariant
- **Dead-letter queue on every queue**, with an admin view. Silent message loss is the worst failure
  mode in this shape
- **Contracts live in `/shared` and are versioned.** No service reaches into another's internals
- **Each service: own Dockerfile, own CI job, own deploy, own SLO, independently rollback-able**
- **Trace propagation across every hop.** `traceId` already flows in logs — carry it through queue
  messages so one recording is followable end to end across five services
- **Do not create a new service without telling me what it costs to operate.** Every service is a
  deploy, a dashboard, an alert, an on-call surface. Earn it

### 3.4 Monorepo · **P0**

One repo, npm workspaces (add Turborepo only if build times justify it).

```
~/algominutes/
  apps/
    ios/            Native SwiftUI (from ios-native/)
    android/        Native Kotlin (Track B; audio layer ported)
    web/            React web app (from src/)
  services/
    api/            Consolidated HTTP surface
    transcoder/
    summarizer/
    embedder/
    extractor/      NEW
    billing/
    notifier/
  packages/
    contracts/      zod schemas + generated OpenAPI; Swift and Kotlin models generated from here
    db/             kysely schema, migrations, repo layer
    ai/             gemini-call, prompt templates, redaction
    tokens/         design tokens + i18n strings
  infra/            IaC, deploy config
  docs/
```

Path-filtered CI: touching `apps/web` must not rebuild and redeploy the iOS app.

---

## 4. Platform engineering — absent from the source · **P0 unless marked**

**4.1 Environments.** At minimum **staging** and **production**, as separate GCP projects with separate
Postgres instances, buckets and Firebase projects. The source has one environment; that is how you
test a migration against real user recordings by accident. A local/emulator setup is **P1**.

**4.2 Secrets.** **Google Secret Manager, never `.env` in the repo.** Services read secrets at
runtime via workload identity; CI reads from GitHub Actions secrets. `.gitignore` covers `.env*` and
the gitleaks gate runs on every push with an **empty allowlist**. Given this codebase's history of a
tracked `.env`, treat any secret in git as an incident: rotate, then purge with `git filter-repo`.

**4.3 Infrastructure as code · P1.** Terraform for Cloud Run services, Cloud Tasks queues, Postgres,
buckets, IAM and secrets. Two environments diverging by hand is a debugging tax that compounds. If P0
timing does not allow it, write the console steps down in `docs/runbooks/` so it is reproducible.

**4.4 Database migration discipline.** Never edit a committed migration — add a new one. Use
**expand/contract**: add the column, backfill, switch the code, drop the old column in a later
release — so a rollback never strands the schema. Migrations run in CI against staging before
production. A tested rollback path for every migration that touches live data.

**4.5 Observability.** Structured logs with `traceId`/`userId`/`noteId`/`workspaceId` already exist —
keep the invariant and extend it across queues. Add distributed tracing, per-service dashboards
(latency, error rate, queue depth, DLQ depth), and alerts on: pipeline failure rate, DLQ non-empty,
crash-free rate below threshold, p95 time-to-summary, **and daily spend**.

**4.6 Cost controls · P0, non-negotiable.** GCP budget alerts with hard thresholds. Per-service cost
attribution. A **circuit breaker that halts the pipeline** if spend exceeds a daily cap. A free tier
plus an AI pipeline plus no cap is how a solo-founder product generates a five-figure bill overnight.

**4.7 Backups and DR.** Automated Postgres backups with a **tested restore** — an untested backup is
not a backup. Object storage versioning. A written RTO/RPO, even a modest one.

**4.8 Branching and review.** `main` protected, no direct pushes, PR required, CI green to merge.
Conventional commits, one concern per PR. Tags drive releases. Keep the source's four
`.claude/agents/` invariant checkers running in CI.

---

## 5. What you are inheriting — protect this

Every item is a working asset whose correctness was earned in production. Port it, adapt its
configuration, extend it. **Do not rewrite, refactor for taste, or "modernise" any of it** unless a
phase says so or it is provably broken. If you think one needs replacing, stop and make the case.

| Asset | Location | Why it is expensive to rebuild |
|---|---|---|
| Chunked STT v2 pipeline | `services/transcoder` | Long-audio chunking with idempotent Cloud Task replay |
| Gemini retry ladder | `shared/gemini-call.cjs` | Shared by summariser and transcoder fast-path; schema-constrained output fixes silent truncation |
| PII pre-scrub | `shared/redaction.cjs` | Redacts before text reaches Gemini *or* the embedder. Almost no competitor does this |
| Hybrid retrieval + chat | `functions/search-and-chat.cjs` | RRF over pgvector + keyword; recall@10 = 1.000 measured |
| Embeddings + chunking | `services/embedder`, `db/migrations/002` | Working pgvector schema and chunk strategy |
| iOS audio capture | `ios-native/Services/Recorder*`, `AudioSessionCoordinator`, `RecorderWatchdog` | Background recording, session coordination, watchdog |
| **Android audio capture — already Kotlin** | `android/app/src/main/java/com/wassup/meeting` (~1.25k LOC) | `BackgroundRecorder` (ForegroundService + MediaRecorder), `BroadcastRecorder` (MediaProjection, app audio **and** mic). **The hard part of Track B already exists** |
| Broadcast extension (iOS) | ReplayKit extension + App Group handoff | On-device capture of another app's audio — what competitors pay a server bot to do |
| Native iOS app | `ios-native/` — 81 Swift files, ~11.7k LOC | Design system, note detail, player, templates, rating, settings, import, scan, chat |
| React web app | `src/` — ~6.7k LOC | Becomes the v1.0 web client |
| Pending-recording handling | `PendingRecordingsView.swift` | Groundwork for offline capture |
| Export | `functions/export-note.cjs`, `PDFExporter.swift` | PDF and DOCX round-trip |
| Cost model | `src/lib/costs.ts`, `CostModel.swift`, `AdminCostsCard.tsx` | Foundation of pricing |
| Capture strategy | `docs/decisions/0002-*.md` | Four-tier model already reasoned through |
| Engineering discipline | `CLAUDE.md`, `.claude/agents/` ×4, CI gates | Invariant checkers — keep all of it |

---

# TRACK A — Launch

## A1 — Audit and extraction record · **P0**

Change nothing in the source. Write `EXTRACTION-AUDIT.md` into `~/algominutes/docs/`.

**Classify every tracked file** as **PLATFORM** (would exist in any meeting recorder), **CLIENT**
(exists only because of this client), or **MIXED** (generic structure, client content — list with line
numbers). Add an orthogonal **CAPACITOR-ONLY** tag. Give every PLATFORM file a one-line reason it is
generic.

Known CLIENT anchors, not exhaustive: `src/index.css` (the `INTEGRANT DESIGN SYSTEM` token block) ·
`shared/summary-templates.cjs` (the `clinical` template) · `src/App.tsx` (`MAX_RECORDING_SECONDS`
two-hour cap, the alpha comment on the removed UPGRADE button) · `ios-native/project.yml`, `DEPLOY.md`,
`README.md` (`DEVELOPMENT_TEAM: HX9DZ34625`, profile `"Wassup App Store"`) · `.firebaserc`,
`firebase-applet-config.json`, `android/app/google-services.json`, `GoogleService-Info.plist` (project
`wassup-meeting`) · `PROJECT.md`, `plan-*.md`, `phase*-bug-log.md`, `docs/decisions/`, `reports/`,
`evidence/`, `scratch/`, `recordings/`, `evals/` · `db/migrations/seed-e2e-test-user*.sql`.

**Contamination sweep:** any real recording, transcript or personal data in the tree or in `git log`;
clinical vocabulary inside generic code; any client-owned credential or project ID. **Report locations
only — never print a secret value or personal data.**

**History and secrets:** `git rev-parse --is-shallow-repository` (if true, **stop**) ·
`git log --all --full-history --name-only -- '**/.env*' '**/*.pem' '**/*.p12' '**/*.keystore' '**/serviceAccount*.json' '**/GoogleService-Info.plist'` ·
`gitleaks detect` with the repo's config, then with an empty allowlist — report the delta.

**Licences:** any GPL/AGPL dependency (blocking for closed-source commercial); confirm the bundled
fonts' SIL OFL terms and treat them as CLIENT if they are the client's brand choice.

## A2 — Repository foundation · **P0**

In `~/algominutes`: `git init` if needed, remote `https://github.com/Algorythmos-AI/algominutes.git`,
**no shared history with the source**. Proprietary `LICENSE`, all rights reserved, © 2026 Algorythmos
Pty Ltd — the source has none, do not carry that forward. `.gitignore` covering `.env*`, keystores,
provisioning profiles, service-account JSON, build output. `.gitleaks.toml` with the allowlist
**emptied**. Scaffold the §3.4 monorepo layout with workspaces. Protect `main`. Commit
`EXTRACTION-AUDIT.md`.

## A3 — Port the platform, consolidate the API, fix the contract · **P0**

**Port into the §3.4 layout:** `lib/` and `db/migrations/` (renumbered from `000`, minus client
fixtures) → `packages/db` · `shared/gemini-call.cjs`, `shared/redaction.cjs`, prompt templates →
`packages/ai` · `services/*` → `services/*` · `server.ts` **and all Firebase Functions handlers** →
`services/api` per §3.1 · `ios-native/` → `apps/ios` minus signing and branding · `src/` →
`apps/web` minus client design tokens · the **Kotlin audio classes** → `apps/android` with Capacitor
glue replaced by a direct interface · `.claude/agents/` (all four).

**Do not port:** `capacitor.config.ts` · the Capacitor `ios/` target · any `@capacitor/*` dependency ·
`PROJECT.md` · `plan-*.md` · `phase*-bug-log.md` · `docs/decisions/` · `reports/` · `evidence/` ·
`scratch/` · `recordings/` · `evals/` · `.claude/skills/wassup-*.md`.

Port an adapted `CLAUDE.md`. **Keep** every engineering invariant: Postgres is source of truth and all
note mutations go through the repo layer; Vertex AI clients only inside Cloud Run
(`generativelanguage.googleapis.com` does not work from the VPC connector — do not relearn this);
schema-constrained Gemini calls with `responseMimeType` + `responseSchema`; no silent catches;
structured logging carrying `traceId`/`userId`/`noteId`/`workspaceId`; PII scrub before any model or
embedder call; workspace-filtered queries; idempotent task replay. **Delete** every reference to the
client, the alpha user, phase history, ADR numbers and the engagement sequence. Add the §3.3 service
rules to it.

**Build `services/extractor` · P0.** Move PDF, DOCX, OCR and YouTube text extraction server-side.
This kills the JS-only dependency problem before it forces three implementations.

**API contract and versioning · P0.** Define once in `packages/contracts` (zod → OpenAPI); generate
Swift and Kotlin models — never hand-write three copies. **Version from day one** (`/v1/...`), never
break a live version. Every client sends a version header; the server refuses unsupported clients with
a friendly "please update", not a 500. **iOS and web ship before Android — old builds must keep
working.**

**Eval harness · P1.** Do not port `evals/queries.jsonl` (labelled against the client's corpus).
Recreate with synthetic recordings; treat recall@10 as a release gate.

## A4 — Provision infrastructure · **P0** ⚠️ **stop and ask for each identifier**

Accounts, not code. Replace — never rename, never copy.

| Item | Source | Action |
|---|---|---|
| Apple Developer team | `HX9DZ34625` | Algorythmos' own team ID |
| Provisioning profile | `"Wassup App Store"` | New profile, Algorythmos account |
| Firebase / GCP project | `wassup-meeting` | **Two new projects** — staging and production |
| `google-services.json`, `GoogleService-Info.plist`, `firebase-applet-config.json` | client project | **Regenerate — never copy** |
| Cloud Run, Cloud Tasks, Postgres, buckets, Crashlytics | client infra | Stand up fresh, per environment |

The iOS broadcast extension needs its own **App Group** and a separate extension bundle ID — get both
right now, because retrofitting App Groups breaks the recording handoff silently. Android needs a fresh
signing keystore; **never** reuse the client's. Enable **Play App Signing** and store the upload key
safely — losing it is unrecoverable. Set **budget alerts and the spend circuit breaker (§4.6) before
the first load test**, not after.

## A5 — Rename to AlgoMinutes · **P0**

No blind global `sed` — `wassup` appears in package paths and bundle identifiers where a careless
replace breaks signing without failing loudly. Class by class, commit per class. Variants: `wasssup`,
`wassup`, `Wasssup`, `Wassup`, `WASSUP`, `wassup-meeting`, `com.wassup.meeting`, `Wassup Doc`.

**iOS** — edit `project.yml`, never the generated `.xcodeproj` · `name: Wassup` → `AlgoMinutes`,
`bundleIdPrefix: com.wassup` → `com.algorythmos` · targets → `AlgoMinutes`/`AlgoMinutesTests` ·
`PRODUCT_BUNDLE_IDENTIFIER` → `com.algorythmos.algominutes` · directory `Wassup/` → `AlgoMinutes/`,
`WassupApp.swift` → `AlgoMinutesApp.swift` · `AlgoMinutes.entitlements`, keychain group →
`$(AppIdentifierPrefix)com.algorythmos.algominutes` · `INFOPLIST_FILE`, `CODE_SIGN_ENTITLEMENTS`,
Crashlytics script paths follow · `xcodegen generate`, clean build

**Android** — `namespace` and `applicationId` → `com.algorythmos.algominutes` · package tree
`com/wassup/meeting/` → `com/algorythmos/algominutes/` including `androidTest` · FileProvider authority
→ `com.algorythmos.algominutes.fileprovider`, deep links → `algominutes.com` · `strings.xml`
`app_name` → `AlgoMinutes`

**Web / services** — `package.json` names → `algominutes`, `@algominutes/api` etc, real versions ·
`index.html` title, `metadata.json`, `public/` manifest and icons · env var prefixes ·
`ALLOWED_ORIGINS` and CORS → `algominutes.com`, `api.algominutes.com` · database name, buckets, queues,
cookie names, service names, analytics IDs

## A6 — Generalise the product

**A6.1 Templates · P0.** Remove `clinical`. Keep `general` and `actions_only`. Add `standup`,
`interview`, `sales_call`, `lecture`, `one_on_one`, `board_meeting`, `client_meeting`. Each needs its
own prompt and `responseSchema` — follow the structured-output invariant, do not loosen it. Define once
in `packages/ai` so every client renders the same set.

**A6.2 Recording cap · P0.** Replace the two-hour cap and its client justification with a plan-derived
limit. Named config constant.

**A6.3 Auth and account model · P0.** **Sign in with Apple is mandatory on iOS** if any other
third-party sign-in is offered — already wired, keep it. **Decide guest mode versus forced signup**:
letting someone record and see a summary before creating an account is one of the biggest conversion
levers in this category, but if you allow it, design anonymous→permanent upgrade **now** — retrofitting
means migrating orphaned data. One account across all three surfaces resolving to one subscription.
Sign-out, account switching, token refresh everywhere. **Data export for portability · P1.**

**A6.4 Onboarding, empty and error states · P0.** Permissions explainer, one-tap first recording,
sample note. Audit every surface for states an unattended public user will hit.

**A6.5 Design system · P0.** Client tokens are gone. Fresh AlgoMinutes palette and type scale in
`packages/tokens`, applied in SwiftUI `Theme.swift`, the Compose theme and `apps/web`.
`TODO(brand):` for final assets — do not generate artwork.

**A6.6 Copy audit · P0.** ADR 0002 requires that UX never imply system-audio capture it does not
perform. Copy must match what the broadcast path actually ships as. App Review reads this closely.

**A6.7 Strings externalised · P0; translation · P1.** Externalise every user-facing string into
`packages/tokens` **now** — retrofitting i18n across three clients is miserable. English in v1.0,
French next. Per-note transcription language with auto-detect is **P1**; transcript translation **P3**;
right-to-left out of scope, recorded.

**A6.8 Tablet support · P1.** `ios-native/project.yml` sets `TARGETED_DEVICE_FAMILY: "1"` — iPhone
only — in **both** the base `settings` block and the target. Both become `"1,2"`. The flag is five
minutes; doing it well is not: audit SwiftUI views for hardcoded widths, adopt size classes, make the
iPad note detail a split layout rather than a stretched phone layout (the commonest iPad rejection),
verify `.sheet` and `.fullScreenCover` on a large canvas, support landscape. Android: Compose
`WindowSizeClass`, landscape, split-screen, foldable resize. **Verify a recording survives rotation
and resize.** Separate iPad and tablet screenshots.

**A6.9 Accessibility · P1.** VoiceOver and TalkBack labels, Dynamic Type without clipping, touch
targets, contrast.

## A7 — Reliability and async UX

The source served one attentive user on good connectivity. A public audience records in basements and
car parks, then closes the app. **This is what separates a demo from a product.**

**A7.1 Offline-first capture · P0.** Recording must **never** depend on connectivity — audio is written
locally first, always. A recording survives app kill, OS kill, battery death and reboot; on relaunch
the user is offered the recovered file, never a silent loss. Local recordings visible and playable
before upload. Per-recording state: recorded → uploading → processing → ready → failed.

**A7.2 Resumable background upload · P0.** Chunked resumable upload — a 90-minute recording over mobile
data *will* be interrupted. iOS `URLSession` background transfers; Android `WorkManager`. Retry with
backoff, continue backgrounded, resume after reboot. Wi-Fi-only setting **P1**.

**A7.3 Processing notifications · P0.** **FCM push on both platforms** via `services/notifier` for
"your notes are ready" and for failures. Async processing without a completion notification means users
leave and never return. Local notification fallback. Deep link into the note. **Never ask for push
permission on first launch** — ask after the first recording.

**A7.4 Failure handling and quota integrity · P0.** Every pipeline stage needs a user-visible failure
state with a plain-English cause and a retry. **Refund metered minutes on pipeline failure** — a
reversal entry in `usage_ledger`, not a deletion. Partial success is normal: a transcript with a failed
summary must still be readable and regenerable. DLQ per §3.3 with an admin view.

**A7.5 Performance budget · P1.** Explicit targets for time to first transcript, time to summary on a
60-minute recording, cold start, note-open latency. Measure and report actuals.

## A8 — Web app · **P0** *(ships in v1.0)*

Read, manage and pay. **No capture.** The React app largely exists — generalise and finish it.

**P0:** note reading (transcript, summary, playback, timestamps) · edit and rename · search and
transcript chat · upload and import · export (PDF, DOCX) · account, subscription and **Stripe
billing** · responsive down to tablet width.
**P1:** folders and bulk operations · the public share-link viewer at `/s/**`, only once hardened.

Park the browser `MediaRecorder` path behind a disabled flag — do not ship it, do not delete it. ADR
0002 Tier 2 is **P3**. Web never leads the apps.

**Compliance pages · P0**, on the marketing site, not in the product: Privacy Policy and Terms at
public URLs, a **web-accessible account-deletion request page** (Play requires this), a support URL,
and a marketing page with store badges.

## A9 — Revenue layer *(nothing here exists in the source)*

**A9.1 Plans and entitlements · P0.** `plans`, `subscriptions`, `usage_ledger` via migration. **Free**
120 min/month · **Pro** ~A$19–29/mo, ~1,500 min · **Team** per-seat (**P2**). Config-driven limits.
Entitlement checked **server-side** on every metered action; never trust the client.

**A9.2 Metering · P0.** Meter minutes at ingest, **before transcode is queued** — rejecting over-quota
work after paying Google for STT is the expensive mistake. Append-only `usage_ledger` keyed by
`userId` + `noteId`, idempotent under replay, with reversal entries per A7.4. Per-user and per-IP rate
limits on upload and chat. Extend `costs.ts`, `CostModel.swift` and `AdminCostsCard` into real
per-minute COGS reporting, wired to §4.6.

**A9.3 Trial versus free tier · P0 decision.** A trial forces a decision and converts harder; a free
tier grows word of mouth and costs compute forever. Model both, recommend one, implement with
**StoreKit 2 introductory offers** and **Play free-trial offers**, not home-grown logic.

**A9.4 Payments — dual rail, one entitlement · P0**, in `services/billing`.

| Rail | Surface | Cut | Net on A$29 |
|---|---|---|---|
| StoreKit 2 | iOS | 30%, **15% under Apple's Small Business Program** | ~A$24.65 |
| Play Billing | Android | 30%, **15% on the first $1M** | ~A$24.65 |
| Stripe | Web | ~2.9% + fixed fee | ~A$28.00 |

**Enrol in both small-business programmes before the first sale** — the highest-leverage commercial
action in this build. **One entitlement source of truth in Postgres**, keyed to the user, not the rail:
a web subscriber is entitled in the apps immediately and vice versa. Server-side receipt validation;
webhooks for renewal, cancellation, refund, grace period, retry, and **cross-rail duplicate
subscription** — someone who buys on web and again on iOS must not be silently double-charged.
⚠️ **Check current App Review Guideline 3.1.3 before writing any in-app copy about web pricing** — what
an iOS app may *say* about external purchase is jurisdiction-dependent and has changed repeatedly.
Flag the current rule rather than assuming.

**A9.5 Paywall and purchase UX · P0 — a common rejection cause.** **Restore Purchases must be reachable
without signing in** on iOS; Android needs the equivalent. Show price, billing period, renewal terms
and links to Terms and Privacy **on the paywall**. Provide a manage/cancel route deep-linking to store
settings. Place the paywall after the first successful summary and at the quota-hit moment — **not** on
first launch. Handle pending, deferred and grace-period states.

**A9.6 Instrument · P0.** Signup, first recording, first summary viewed, quota hit, paywall viewed,
trial start, purchase, cancellation. Without the quota-hit → paywall-viewed funnel you cannot price
this.

**Before pricing is fixed · P0:** report a measured blended cost per minute across STT, Gemini and
storage. A 1,500-minute tier at A$29 only works if that number is well under one cent.

## A10 — Launch blockers

**Diarisation · P0 for credibility — and the highest-value cut if you must.** Bug 17, deferred under
ADR 0005, needs an STT v2→v1 migration of the chunked pipeline, not the config change ADR 0004 assumed.
Speaker labels are the most-compared feature in this category. **If the release is at risk this is the
one cut that buys the most time — but it will show in reviews, so bring me the tradeoff rather than
deciding alone.** Ship with **speaker renaming**; "Speaker 1" is half a feature.

**Share links · P0 if shipped, otherwise disable.** The `shares` table is dead schema and unsafe:
plaintext token, nullable `expires_at`, no `revoked_at`. Before activating — hash the token, mandatory
expiry, revocation column, `robots.txt` disallow, `X-Robots-Tag: noindex` on `/s/**`. Verify
`006_shares_hardening.sql` covers all four. **Shipping it unhardened is not an option; shipping without
it is.** Once safe it is your cheapest growth loop.

**Consent · P0 (conservative default), full layer P1.** Australian recording law is state-based; NSW
generally requires all-party consent for a private conversation. v1.0: conservative default behaviour
and a prominent in-app notice, plus `docs/CONSENT.md` with `TODO(legal):`. The full layer —
jurisdiction awareness, per-participant consent log, audible announcement, retention controls — is P1
and **needs a written legal opinion first. Do not implement or guess the rules.** Design both recorders
so consent capture slots in without rework. Done properly this is the moat.

**Store compliance · P0.** Privacy nutrition labels and `PrivacyInfo.xcprivacy` matching real data
flows; Play Data Safety likewise. Rewrite `NSMicrophoneUsageDescription` and every Android permission
rationale — vague strings get recording apps rejected. Verify account deletion end to end plus the web
deletion page. Set age ratings deliberately. Timestamped terms acceptance at signup.

**In-app support and feedback · P0.** Help/FAQ, a contact route attaching diagnostic context (app
version, device, note ID — **never** audio or transcript content), and a way to report a bad transcript.
`TranscriptRatingCard` is the seed — route ratings somewhere you will read.

**Store listing as distribution · P0.** Keyword research for title and subtitle, screenshots showing
the **summary output** rather than the record button, a demo video, and a ratings prompt after a
*successful* summary — never on launch.

**Data retention · P0.** User-set retention, deletion propagating to backups within a stated window, a
written statement of what is kept and where, and a local-storage purge policy after upload.

## A11 — Release engineering and QA · **P0** *(start during A3)*

**Pipelines, path-filtered.** Per-service Cloud Run deploy on tag. iOS: build, sign, TestFlight
(fastlane or Xcode Cloud). Android: build, sign, Play internal track. Web: static deploy. Secrets from
CI, never the repo. Staging deploys on merge to `main`; production on tag.

**Versioning.** One scheme across all surfaces with a documented marketing-version → build-number
mapping. `CURRENT_PROJECT_VERSION` is currently `14` — reset deliberately and record why. Since updates
ship in versions, establish this before the first submission.

**Release process.** Phased rollout on both stores — never 100% on day one. Documented rollback per
surface, including services. Crashlytics alerting with a crash-free-rate threshold that halts a rollout.

**Test strategy.** Server: vitest, the four invariant checkers, `check-no-silent-catch.sh`, the eval
harness, plus **contract tests** so a change in `packages/contracts` fails CI on any client that
breaks. iOS: XCTest plus a UI smoke test through record → transcript → summary. Android: JUnit plus
Compose UI tests. Web: a smoke test through upload → summary → export.

**Manual device matrix — mandatory.** The broadcast extension and MediaProjection **cannot** be verified
on simulators. Minimum: two iPhones on two iOS versions, one iPad, two Android OEMs (one Samsung), one
Android tablet, current Chrome and Safari. Document what was tested on what. Include a two-hour
recording soak test, backgrounded, screen locked, on mobile data.

---

# TRACK B — Android

## B1 — Android parity plan ⚠️ **STOP — report before building**

1. **Inventory what exists natively.** Read every file under
   `android/app/src/main/java/com/wassup/meeting`. Document what `BackgroundRecorder` and
   `BroadcastRecorder` implement, their permission and lifecycle requirements, ForegroundService and
   MediaProjection setup, how recorded files are handed back, and what is Capacitor glue to replace
2. **Derive the feature surface** by cross-referencing `apps/ios` and `apps/web`
3. **Confirm `services/extractor` (A3) removes the JS-dependency problem** — if any client-side
   extraction remains necessary, say which and why
4. **Propose the stack** — Kotlin + Compose, Firebase Auth Android SDK, Media3/ExoPlayer, Retrofit or
   Ktor, WorkManager for upload
5. **Recommend the v1.1 cut** — what Android can ship *without*

**Report all five, then stop.**

## B2 — Build the Android client

- **Start from the audio layer that already exists.** Port `BackgroundRecorder` and `BroadcastRecorder`,
  strip the Capacitor bridge, expose a clean Kotlin interface. **Do not rewrite these** — MediaProjection
  and ForegroundService lifecycles are where hard-won correctness lives
- Then auth → home → recorder flow → pending recordings → note detail → files → import → search and
  chat → export → settings → paywall
- Use generated models from `packages/contracts`; never hand-write API types
- Match iOS **behaviour**, not iOS pixels
- Foreground-service notification, permission rationale and Play's sensitive-permission declarations for
  microphone and MediaProjection must be right first time
- Android must satisfy every **P0** item in A6, A7, A9 and A10 before its own submission

---

# POST-LAUNCH

## v1.2 · **P2**

**Quick capture.** iOS: Home and Lock Screen widgets, App Intents / Siri, Action Button, Live Activity
with elapsed time and a stop control. Android: widget, Quick Settings tile, App Shortcuts, a useful
foreground notification. **Share sheet import on both platforms** — an iOS Share Extension and an
Android share target so audio arrives from Voice Memos, Files, Drive or a browser; the source has none
and this is the cheapest growth in the import funnel. **In-recording highlights** — one button
timestamping "this matters", surfaced in the summary and weighted by the summariser.

**Privacy features as product.** Biometric app lock; on-device encryption at rest for pending uploads;
a plain-English "where does my audio go" screen.

**Team tier** — shared library, admin controls, retention policy, audit export.

## Later · **P3**

- **Real-time transcription — decide before building, do not assume.** Owll markets live transcription;
  the pipeline is chunked and post-hoc. (A) keep post-hoc — cheapest, most accurate; (B) streaming STT
  for live partials with the chunked pipeline still authoritative — materially more cost per minute and
  a second integration; (C) live transcription as a paid-tier feature, giving the paywall something
  concrete to sell. Cost all three against measured per-minute pricing and recommend
- **Calendar integration** — pre-fill meeting title and attendees; ADR 0002 Tier 1 already depends on
  Calendar OAuth. Not now, but make sure the note schema has somewhere to put it
- Transcript translation · ADR 0002 Tier 1 Meet transcript import · Tier 2 browser extension
- **Deliberately out of scope:** call recording (no iOS API; every implementation is a conference-bridge
  merge with telephony cost and a poor first run), Apple Watch, Mac, server-side meeting bot, flashcards
  and quizzes, contact manager. Recorded so these are choices, not oversights

---

## Verify — before each submission

- `grep -ril 'wassup\|wasssup\|slater\|integrant\|clinical' . --exclude-dir=.git` returns nothing
- **Casing audit:** no user-visible string contains `Algominutes` or `algoMinutes`; the GitHub repo,
  every bundle ID, package path, npm name, service name, bucket and queue is lowercase `algominutes`
- No `@capacitor/*` dependency; no `capacitor.config.ts`; no Capacitor `ios/` target
- `git remote -v` points only at `Algorythmos-AI/algominutes`; `git log` shows no inherited history
- **One HTTP surface** — no Firebase Function serves an endpoint `services/api` also serves
- `xcodegen generate`, clean iOS build; Android assembles and installs; web builds and deploys
- Every service builds, deploys and rolls back independently; each has a dashboard and an alert
- **On real devices, not simulators:** the iOS broadcast extension records and hands off via App Group;
  Android MediaProjection records with both channels active
- **Airplane-mode test:** record 10 minutes offline, kill the app, relaunch — the recording is recovered,
  then uploads and processes when connectivity returns
- **Interruption test:** an incoming call mid-recording does not lose the recording
- A recording survives rotation, resize and split-screen
- Push fires on processing completion and deep-links into the note
- A pipeline failure produces a user-visible error **and** a reversal entry in `usage_ledger`
- An over-quota upload is rejected **before** transcode is queued
- **Restore Purchases works on a fresh install without signing in**
- A two-account test proves no cross-workspace leakage
- An unsupported client version receives a friendly upgrade prompt, not a 500
- A message that exhausts retries lands in a DLQ and is visible to an admin
- **The spend circuit breaker halts the pipeline in a staging test** — verify it, do not assume it
- A Postgres backup has been **restored** into staging at least once
- `gitleaks detect` with an empty allowlist is clean; no secret is in git or in a `.env`
- No file references the client's Firebase project, Apple team, keystore or buckets
- Every client renders identical summary templates and localised strings from `packages/`

Report anything you could **not** verify rather than asserting it works.

---

## Working constraints

- **Conventional commits**, one concern per PR. `main` protected, CI green to merge
- **Never commit or push to the source repo.** Read-only
- **Never force-push.** Never rewrite history without telling me what will be lost
- **Never print a secret, credential or personal data** — location and type only
- Missing an identifier — team ID, project ID, bucket, App Group, keystore? **Stop and ask.** Never
  invent one
- Invoke the four `.claude/agents/` checkers eagerly after any non-trivial write
- **Verify with a query or a log line, not a deploy.** Shipped is not verified
- When a phase would require rewriting anything in §5, stop and make the case first
- Any contract change is a three-client change — say so before making it
- **Do not add a service without telling me its operating cost.** Every service is a deploy, a
  dashboard, an alert
- **Track A is the critical path. Never block it on Track B**
- **When scope threatens the release, bring me the cut. Do not silently extend**
