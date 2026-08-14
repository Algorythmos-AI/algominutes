# EXTRACTION-AUDIT — AlgoMinutes

**Phase A1 · Track A · P0.** Read-only audit of the source repository ahead of extraction into
`~/algominutes`. Produced by classifying every tracked file, sweeping for client contamination and
personal data, checking git history and secrets, and auditing licences.

- **Source (READ-ONLY):** `~/src/wasssup-meeting` — full clone, `main` @ `4058a67`, 235 commits.
- **Nothing in the source was modified** except one authorized safety change: the `origin` **push URL
  was disabled** (`git remote set-url --push origin no_push`) so an accidental `git push` cannot reach
  the source. Fetch URL is untouched; the change is local `.git/config` only and reversible.
- **Locations and types only** below — no secret value or personal-data content is reproduced.
- Universe: **491 git-tracked files** (`git ls-files`). All greps via `git grep` (untracked/ignored excluded).

---

## 0. Preflight (§0) — result

| Gate | Requirement | Result |
|---|---|---|
| **1** | GitHub repo named lowercase `algominutes` | ✅ **PASS** — resolves canonically as `Algorythmos-AI/algominutes` (private, `main`, empty). No capital `A`. |
| **2a** | Source clone **outside** `~/algominutes` | ✅ PASS — `/Users/samkalaliya/src/wasssup-meeting` |
| **2b** | Full clone (non-shallow) | ✅ PASS — `is-shallow-repository = false`, 235 commits |
| **2c** | **No write remote configured** | ⚠️ Initially **FAILED** (origin had a push URL to `skalaliya/wasssup-meeting`). **Resolved** by disabling the push URL (see above). Now PASS. |

> Note: two other local clones exist (`~/wasssup-meeting`, identical `main`@`4058a67`; and
> `~/Documents/wasssup-meeting-main`, branch `fix/ci-functions-params`, 72 commits). Only
> `~/src/wasssup-meeting` — the plan's named source — was used and hardened. The others were left
> untouched.

---

## 1. Classification method

Each tracked file is classified **PLATFORM** (would exist in any meeting recorder), **CLIENT** (exists
only because of this client), or **MIXED** (generic structure, client-specific content — line numbers
given). An orthogonal **CAPACITOR-ONLY** tag marks files that exist only for the Capacitor bridge that
the plan removes. Counts reconcile to 491. Large homogeneous asset groups (icon sets, splash PNGs,
Gradle wrapper) are classified as a group with a count rather than enumerated file-by-file.

**Seven contamination tokens** a rename must hit (agent-confirmed): `wassup` / `wasssup` (brand),
`com.wassup.meeting` (bundle/package/App-Group id), `wassup-meeting` (GCP/Firebase project id),
`Wassup Doc` / `Wassup Meeting` (display name), `INTEGRANT` (design-system name), `Slater` (client /
alpha user), `clinical` (client domain).

---

## 2. Per-subtree classification

### 2.1 `ios-native/` — native SwiftUI app (106 files)
Class: **PLATFORM** (a generic meeting recorder: capture + review), with client naming, tokens and
branding overlaid.

| Files | Class | Notes / reason |
|---|---|---|
| `Wassup/Services/*` (Recorder, AudioSessionCoordinator, RecorderWatchdog, Upload*, Recording*, APIClient, AudioPlayer*, SSEParser, NotesRepository, TranscriptRepository, StoragePaths, StuckBudgets, TitleDeriver, TextNoteBuilder, PDFExporter, ScanService, CostModel …) | **PLATFORM** | Generic capture/upload/playback/repository layer — the §5 iOS audio assets. Reason: any recorder needs background capture, session coordination, resumable upload, note repo. MIXED only via `clinical`/`consult` **comment** vocabulary in ~20 files (e.g. `RecorderService.swift:34,150,245`). |
| `Wassup/Models/*` (Note, NoteMeta, SummaryTemplate, SpeakerLabel, TranscriptTime, …) | **PLATFORM** | Generic domain models. **`SummaryTemplate.swift` is MIXED** — `case clinical` (12), label "Clinical consult" (20), desc (31–32), `stethoscope` symbol (41); generalise per A6.1. |
| `Wassup/Features/*` (Home, Recorder, NoteDetail ×17, Files, Chat, Import, Scan, Settings, Auth, Root) | **PLATFORM** | Generic review/record UI. MIXED via `Wassup Doc`/`clinical` copy in several views. `TranscriptRatingCard.swift` = feedback seed (A10). |
| `Wassup/DesignSystem/*` (Theme, Components, IconTile, ProgressRing, Sheets, SkeletonRow) | **MIXED** | Generic components carrying **INTEGRANT** client tokens; **`Theme.swift`** holds the palette → rebuild in `packages/tokens` (A6.5). |
| `Wassup/App/WassupApp.swift`, `WassupTests/WassupTests.swift`, dir `Wassup/`, `WassupTests/` | **MIXED** | Client-named **paths/filenames** — rename affects filenames, not just content. |
| `Wassup/Resources/Fonts/Rajdhani-{Bold,Medium,SemiBold}.ttf` + `OFL.txt` | **CLIENT** | Client brand typeface choice. Licence fine (SIL OFL 1.1 — embeddable in paid closed-source); swap for AlgoMinutes brand (A6.5). |
| `Wassup/Resources/Assets.xcassets/*` (AppIcon, Logo, Splash — ~20) | **CLIENT** | Brand imagery → regenerate. |
| `project.yml` | **MIXED** | Signing/branding — see §5. `bundleIdPrefix`(3), `TARGETED_DEVICE_FAMILY`(24,36), bundle id(35), `DEVELOPMENT_TEAM`(40), profile(43). |
| `DEPLOY.md`, `README.md`, `DEVIATIONS.md` | **CLIENT** | Team `HX9DZ34625` / "Integrant Biotechnology Ltd." / profile "Wassup App Store". |
| `Wassup.entitlements`, `Info.plist`, `scripts/dev-sim-entitlements.plist` | **MIXED** | Keychain group / App Group / reversed-OAuth URL scheme carry `com.wassup.meeting`. |
| `PrivacyInfo.xcprivacy` | **PLATFORM** | Generic privacy manifest — re-verify against real data flows (A10). |
| `scripts/{fetch-fonts.sh, generate-app-icon.swift}`, `.gitignore` | **PLATFORM** | Generic build/asset tooling. |
| `evidence/ios-native/*.png` (2) | **CLIENT** | Login screenshots. |

### 2.2 `ios/` — Capacitor iOS target (38 files) · **CAPACITOR-ONLY**
Class: **CAPACITOR-ONLY → delete** (the plan removes Capacitor), **except a protected asset trapped
inside it** — see the ⚠️ risk in §6.

| Files | Class | Notes |
|---|---|---|
| `App/App/*` (AppDelegate, BridgeViewController, SceneDelegate, storyboards, entitlements, Info.plist, Assets, BackgroundRecorderPlugin.swift, BroadcastRecorderPlugin.swift), `App/CapApp-SPM/*`, `App.xcodeproj/*`, `.gitignore`, `debug.xcconfig` (≈33) | **CAPACITOR-ONLY** | Capacitor shell + plugin bridges → do not port. |
| **`App/BroadcastExtension/*` (SampleHandler.swift, Info.plist, PrivacyInfo, entitlements) + `App/BroadcastExtensionSetupUI/*` (BroadcastSetupViewController.swift, Info.plist)** (5) | **PLATFORM** (housing is CAPACITOR-ONLY) | ⚠️ ReplayKit on-device capture + App-Group handoff — a **§5 protected asset**. **Re-home into `apps/ios`, do NOT delete with the Capacitor target.** |

### 2.3 `android/` — native Kotlin (93 files)
Class: **PLATFORM** (the Track-B audio layer — "the hard part already exists"), with package-path,
Capacitor-glue and branding overlays.

| Files | Class | Notes |
|---|---|---|
| `app/src/main/java/com/wassup/meeting/{RecordingService,BroadcastRecordingService}.kt` | **PLATFORM** | `BackgroundRecorder` (ForegroundService + MediaRecorder) and `BroadcastRecorder` (MediaProjection) core — protect. MIXED via package path + `ACTION_*` constants (`RecordingService.kt:32–33`, `BroadcastRecordingService.kt:53–54`). |
| `.../{BackgroundRecorderPlugin,BroadcastRecorderPlugin}.kt`, `MainActivity.kt` | **MIXED / CAPACITOR-ONLY glue** | Capacitor plugin bridges — strip the bridge, expose a clean Kotlin interface (B2). |
| `app/src/{test,androidTest}/java/com/wassup/meeting/Example*.kt` (2) | **PLATFORM** | Test stubs; MIXED via package path. |
| `app/build.gradle`, `build.gradle`, `settings.gradle`, `variables.gradle`, `gradle.properties`, `proguard-rules.pro`, gradle wrapper (jar/props/gradlew/.bat) | **PLATFORM** | Build infra. **`app/build.gradle` MIXED** — `namespace`/`applicationId` = `com.wassup.meeting` (5,8). |
| `app/capacitor.build.gradle`, `capacitor.settings.gradle` | **CAPACITOR-ONLY** | Capacitor Gradle glue. |
| `app/src/main/AndroidManifest.xml` | **MIXED** | FileProvider authority `${applicationId}.fileprovider` (38); permissions. |
| `app/src/main/res/values/strings.xml` | **MIXED** | `app_name`="Wassup Meeting" (3,4), `package_name`/`custom_url_scheme` (5,6). |
| `app/src/main/res/**` splash PNGs (24), mipmap `ic_launcher*` (≈24), `ic_stat_wassup.png`, launcher XML/vectors | **CLIENT** | Brand imagery → regenerate. |
| `app/src/main/res/{values/styles.xml, values/ic_launcher_background.xml, layout/activity_main.xml, xml/file_paths.xml}` | **PLATFORM** | Generic resources. |
| `app/google-services.json` | **CLIENT — REGENERATE** | Client Firebase config (see §5). |
| `.idea/*` (11) | **CLIENT** | IDE config; `appInsightsSettings.xml` embeds `com.wassup.meeting`. Do not port. |
| `.gitignore` (×2) | **PLATFORM** | |

### 2.4 `services/` — async pipeline (31 files)
Class: **PLATFORM** (§5 transcoder/summarizer/embedder). `db-job` handlers are client-specific ops.

| Files | Class | Notes |
|---|---|---|
| `transcoder/src/*` (stt, ffmpeg, fast-path, handler, route, storage, tasks-client, youtube, db, firestore-mirror, index), Dockerfile, package.json, `.gcloudignore` | **PLATFORM** | Chunked STT v2 pipeline. `youtube.js` = server-side YouTube extraction (relevant to `services/extractor`, A3). MIXED via `clinical` comments / project-id in deploy config. |
| `summarizer/*`, `embedder/*` | **PLATFORM** | Vertex summary + pgvector. `summarizer/src/handler.js:26` MIXED (`Slater`/`clinical`). |
| `db-job/*` (handlers: backfill-pr-d, debug-corpus, eval-recall, verify-phase-0) | **MIXED / CLIENT ops** | ⚠️ **§3.2 decision:** fold `db-job` into `api` or a scheduled job. Handlers reference `Slater`/`peptide`/`prp`/`lady-cdc` → do not port these payloads. |
| `README.md`, `deploy.sh` | **MIXED** | Deploy targets carry `wassup-meeting` project id. |

### 2.5 `functions/` — Firebase Functions (8 files)
Class: **PLATFORM handlers** — the §3.1 consolidation targets (port into `services/api` as routes).

| Files | Class | Notes |
|---|---|---|
| `note-read.cjs`, `export-note.cjs`, `search-and-chat.cjs`, `shared-note.cjs`, `delete-account.cjs` | **PLATFORM** | Move into `services/api`, preserve behaviour (§3.1). MIXED via `clinical`/`patient`/`consultation` strings. |
| `index.js` | **MIXED** | Function wiring; `wassup-meeting` refs (929,1251,1254). |
| `package.json`, `package-lock.json` | **MIXED** | Separate dep tree (all permissive). |

### 2.6 `shared/` — shared libs (14 files)
Class: **PLATFORM** → `packages/ai` + `packages/db`.

| Files | Class | Notes |
|---|---|---|
| `gemini-call.cjs`, `redaction.cjs`, `embeddings.cjs`, `cloud-tasks.cjs`, `logger.cjs`, `pg-query.cjs`, `storage-paths.cjs`, `note-edit.cjs`, `note-feedback.cjs`, `note-terminal.cjs`, `share-links.cjs`, `intelligence.cjs`, `intelligence.d.ts` | **PLATFORM** | §5 protected: Gemini retry ladder, PII pre-scrub, hybrid retrieval, embeddings. MIXED via `clinical`/`patient` comments only. |
| `summary-templates.cjs` | **MIXED** | Templates at 42–93: `general`(47–55), **`clinical`(60–75, remove)**, `actions_only`(79–92), default `general`(95). Rebuild the set in `packages/ai` (A6.1). |

### 2.7 `lib/` (4) · `server.ts` (1)
`lib/{db,embeddings,notes-repo,search-repo}.ts` → **PLATFORM** (repo layer → `packages/db`; the
`notes-repo` invariant). `server.ts` → **PLATFORM** (Express edge → `services/api`). All MIXED only via
`wassup` comments.

### 2.8 `src/` — React web app (36 files)
Class: **PLATFORM** (becomes the v1.0 web client), with tokens/copy/plugins overlaid.

| Files | Class | Notes |
|---|---|---|
| `main.tsx`, `types.ts`, `components/*` (Chat, Search, Import, Scan, Waveform, JobStatus, AdminCostsCard, EqualizerBg, SurfaceBoundary, DeleteAccountConfirmation, BroadcastInstructionSheet, InstantRecorderConsent, YouTubeImport) | **PLATFORM** | Generic review/manage UI. MIXED via `Wassup Doc`/`clinical` copy in several. |
| `lib/*` (apiSchemas, apiUrl, authedFetch, authErrors, costs, noteCommands, noteEdit, noteStatus, crashReport, admin, documentText, imagePdf, ocr) | **PLATFORM** | `documentText.ts`/`imagePdf.ts`/`ocr.ts` = the **JS-only extraction** (`pdfjs-dist`/`mammoth`/`tesseract.js`) → move to `services/extractor` (A3). `admin.ts:2` MIXED. |
| `App.tsx` | **MIXED** | `MAX_RECORDING_SECONDS` two-hour cap (**81**, "Slater staff meetings"; used 94,719,737,1137,1693) → A6.2. Alpha "UPGRADE button removed for Slater alpha" (**2023–2026**). `Wassup Doc`/`clinical` copy throughout. |
| `index.css` | **MIXED** | **INTEGRANT DESIGN SYSTEM** comment (5), `@theme` tokens (13–42), `clinical` (84), Google-Fonts `@import` (Rajdhani/Titillium). → rebuild tokens (A6.5). |
| `pages/{PrivacyPolicy,TermsOfService,SharedNote}.tsx` | **MIXED** | User-visible "Clinical alpha" (Privacy 70; Terms 74,76,78). `SharedNote.tsx` = the `/s/**` viewer (A10 share links). |
| `firebase.ts` | **MIXED** | Client Firebase web config wiring. |
| `plugins/{BackgroundRecorder,BroadcastRecorder}.ts` | **CAPACITOR-ONLY** | Capacitor JS bridges → do not port (web does not capture). |

### 2.9 `tests/` (24) · `db/` (10)
`tests/*` → **PLATFORM** (keep the suite + contract tests, A11). MIXED fixtures: `stt-config.test.ts`
(recognizer `custom-medical` 34,68,107; project id), `summary-templates.test.ts` (asserts `clinical`),
`redaction*.test.ts` (synthetic PII — see §4), `export-note.test.ts` (`Slater`).
`db/migrations/000_extensions … 006_shares_hardening.sql` → **PLATFORM** (renumber from `000`;
`006_shares_hardening` is the A10 share-links fix). `retire-audit-night-stuck-notes.sql` → **CLIENT ops**
(one-off). `seed-e2e-test-user{,-b}.sql` → **CLIENT fixtures — do not port**.

### 2.10 Docs, plans, reports (`docs/` 21 · `reports/` 2 · root markdown)
`docs/decisions/0001–0005` → **CLIENT — do not port** (reasoning referenced, not carried; ADR numbers
dropped). `docs/runbooks/*` → **MIXED** (generic ops procedures wired to client infra — adapt into
`docs/runbooks/` per §4.3, don't copy verbatim; `phase3/phase4-bug-log`, `bug-14-root-cause` are CLIENT).
`docs/ios-recording-status.md` → CLIENT. `reports/{slater-readiness-audit, phase3-e2e-audit}` → CLIENT.
`PROJECT.md`, `plan-{ios-native,phase-4,phase-5,prod-readiness}.md`, `BLUEPRINT.md`, `DESIGN.md`,
`README.md` → **CLIENT — do not port** (`CLAUDE.md` is the exception — see 2.12).

### 2.11 Static assets & config (`public/` 13 · `icons/` 7 · `assets/` 1)
`public/{logo,apple-touch-icon,favicon-16/32,icon-48…512}.png`, `icons/icon-*.webp`,
`assets/brand-logo-master.png` → **CLIENT** brand imagery (regenerate; `TODO(brand)`).
`public/manifest.webmanifest` → **MIXED** (app name). `public/robots.txt` → **MIXED** (`clinical`; also the
A10 `/s/**` disallow lives here).

### 2.12 `.claude/` (8) · `.github/` (3) · root tooling
`.claude/agents/{dual-write-auditor, log-fields-auditor, pii-scrub-compliance, silent-catch-detector}.md`
→ **PLATFORM — port all four** (§4.8 invariant checkers). `.claude/skills/wassup-*.md` (3) →
**CLIENT — do not port**. `.claude/launch.json` → PLATFORM tooling.
`.github/workflows/{gitleaks,invariants}.yml` → **PLATFORM** (keep/adapt); `firebase-deploy.yml` →
**MIXED** (client project). `CLAUDE.md` → **MIXED** (port an adapted copy per A3 — keep invariants, delete
client/alpha/ADR/phase references). Config: `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`,
`eslint.config.js` → **PLATFORM**. `.gitignore` → PLATFORM (extend for `.env*`/keystores/profiles per A2).
`.gitleaks.toml` → **MIXED** (keep; **empty the allowlist** per A2/§4.2).

### 2.13 Do-not-port residue (root)
`capacitor.config.ts` → **CAPACITOR-ONLY**. `mobile/plugins/README.md` → CAPACITOR-ONLY.
`scratch/test-firebase.ts` → CLIENT. `recordings/README.md` → CLIENT placeholder (data dir).
`evals/queries.jsonl` → **CLIENT — do not port** (labelled against client corpus; recreate synthetically, A3).
`.firebaserc`, `firebase-applet-config.json` → **CLIENT — REGENERATE** (§5). `firebase.json`,
`firebase-blueprint.json` → keep (no ids). `firestore.rules`, `storage.rules` → **PLATFORM** (generic
security rules; re-point buckets). `.firebase/hosting.ZGlzdA.cache` (decodes to `dist`) → **CLIENT** build
artifact (do not port). `metadata.json`, `index.html` (title "Wassup Doc — Clinical meeting notes":7),
`package.json`/`package-lock.json` (name + `@capacitor/*` deps to strip) → **MIXED**.

### 2.14 Capacitor-only roster (orthogonal tag, consolidated)
`capacitor.config.ts` · the entire `ios/` target *(minus the BroadcastExtension/SetupUI Swift to
re-home)* · `android/app/capacitor.build.gradle` + `android/capacitor.settings.gradle` ·
`src/plugins/{BackgroundRecorder,BroadcastRecorder}.ts` · `mobile/plugins/README.md` · the Capacitor
plugin wrappers in `android/.../*Plugin.kt` and `ios/App/App/*Plugin.swift` · every `@capacitor/*` and
`@capacitor-firebase/*` dependency in `package.json`.

---

## 3. Contamination sweep (brand tokens)

Repo-wide counts over tracked files:

| Token | Files | Hits |
|---|---|---|
| `wassup` | 139 | 790 |
| `wasssup` | 15 | 44 |
| `slater` | 38 | 152 |
| `integrant` | 3 | 3 |
| `clinical` | 51 | 134 |

**Clinical vocabulary embedded in generic/product-facing code** (must be generalised, not just renamed):
`shared/summary-templates.cjs:60–74` (clinical prompt body) · `ios-native/.../SummaryTemplate.swift`
(enum `clinical` 12/label 20/desc 31/symbol 41) · `src/pages/TermsOfService.tsx:74,76,78` &
`PrivacyPolicy.tsx:70` (user-visible "Clinical alpha") · `index.html:7` · `public/robots.txt` ·
`tests/stt-config.test.ts:34,68,107` (deployed recognizer id `custom-medical`). Pervasive
`consult/clinician/patient` **comment** vocabulary across ~20 Swift files, transcoder/summarizer/embedder,
functions, and several test fixtures — cosmetic but caught by a repo-wide verify grep.

**Verify-grep readiness (§Verify):** after rename `git grep -inE 'wass?sup|slater|integrant|clinical|com\.wassup\.meeting|wassup-meeting'`
must return zero. Beyond file *contents*, the grep will also catch: client-named **paths**
(`ios-native/Wassup/`, `WassupApp.swift`, `WassupTests/`, `android/.../com/wassup/meeting/`,
`.claude/skills/wassup-*.md`), **binary** brand imagery, and the **project id `wassup-meeting`** wherever
infra is referenced. Since the extraction *excludes* the do-not-port docs/evidence/plans, most of the
`slater`/`clinical` doc hits never enter the new repo.

---

## 4. Personal data / real recordings

**No real recordings or personal audio are tracked.** The only tracked media is
`scripts/fixtures/synthetic-pii-test.m4a` — synthetic generator output (paired with
`generate-synthetic-pii.mjs` + `synthetic-pii-script.txt`), **not** a real recording. `recordings/`
contains only `README.md`.

**Likely real transcript content — flagged by path, not opened** (all **CLIENT, do-not-port**):
`evidence/phase-0-e2e-peptides-2026-05-08.json`, `evidence/bug-16-e2e-prp-2026-05-08.json`,
`evidence/pr-b-bug-18-lady-cdc-2026-05-08.json` (filenames name real recording subjects; single-line JSON
with transcript-shaped fields). Remaining `evidence/*.json|.sql|.txt` (10) = verification/log/query output —
CLIENT, do-not-port. `evals/queries.jsonl` and `db/migrations/seed-e2e-test-user{,-b}.sql` may embed real
query strings / a test email — do-not-port. `reports/slater-*` names the client.

**Synthetic (not incidents):** `scripts/fixtures/README.md:19` and `tests/redaction.test.ts`
(29,35,112,149,151) contain the AWS doc example key `AKIAIOSFODNN7EXAMPLE` and deliberately fake
`AIza…`/`ghp_…`/`xoxb-…`/`sk_live_…` samples that exercise the redactor. Allowlisted in `.gitleaks.toml`.

None of this enters `~/algominutes`: the do-not-port list already excludes `evidence/`, `evals/`,
`reports/`, `scratch/`, `recordings/`, and the seed fixtures.

---

## 5. History & secrets

- **Shallow check:** `is-shallow-repository = false` → OK (did not stop).
- **Sensitive files ever committed** (`git log --all --full-history` over `**/.env* **/*.pem **/*.p12
  **/*.keystore **/serviceAccount*.json **/GoogleService-Info.plist`): **none**. Both
  `GoogleService-Info.plist` are gitignored (`ios/.gitignore:19`, `ios-native/.gitignore:5`); no
  keystore, `.p12`, `.pem`, or service-account JSON is tracked now or historically.
- **Currently tracked secret-bearing file:** only `android/app/google-services.json` — a public,
  domain-restricted Firebase Android client key (allowlisted). Must be **regenerated**, never copied.

### gitleaks (repo config vs empty allowlist)
`gitleaks 8.30.1`, 210 commits scanned.

| Run | Findings |
|---|---|
| repo `.gitleaks.toml` | **2** |
| empty allowlist | **8** |
| **delta** | **+6** |

The **+6 delta** is exactly the intended allowlist and is **not** a leak set: `firebase-applet-config.json`
(×2) and `android/app/google-services.json` (×2) — public domain-restricted Firebase client keys — plus
`tests/redaction.test.ts` (×2) synthetic fixtures.

### ⚠️ SECRET-INCIDENT (real, in history only)
The **2 findings the repo config already flags** are a genuine exposure:
`test-gemini.js` and `functions/test-gemini.js` each contain a hardcoded Google/Gemini `AIza…` API key
(literal, no `process.env`). **Added in `c265d2c` (2026-04-23), deleted in `4c93841`** — **not in the
current tree, but reachable in history** on `skalaliya/wasssup-meeting`.

- **Impact on extraction:** none — A2 starts the new repo with **no shared history**, so the key cannot
  travel into `~/algominutes`.
- **Recommended (source-side, your call — I will not touch the source):** **rotate the Gemini API key**
  and purge both blobs from the source history (`git filter-repo`/BFG), per §4.2's "treat any secret in
  git as an incident." The source's own gitleaks CI gate is currently **red** because of these two blobs.

### Client identifiers to replace (locations only — no secret values printed)
Firebase/GCP project **`wassup-meeting`** (project number / sender **`909388484461`**), Apple team
**`HX9DZ34625`** ("Integrant Biotechnology Ltd."), bundle/package/App-Group root **`com.wassup.meeting`**.

| File | Verdict | Where |
|---|---|---|
| `.firebaserc` | **REGENERATE** | project id (3) |
| `firebase-applet-config.json` | **REGENERATE** | apiKey field (2, value redacted), authDomain/projectId/bucket/sender/appId/measurementId (3–8) |
| `android/app/google-services.json` | **REGENERATE** | project_number/id, mobilesdk_app_id, package_name, OAuth client ids, signing SHA1, api_key (31, redacted) |
| `ios/App/App/GoogleService-Info.plist`, `ios-native/Wassup/Resources/GoogleService-Info.plist` | **REGENERATE at build** | not tracked (gitignored) |
| `ios-native/project.yml`, `DEPLOY.md`, `README.md`, `Wassup.entitlements`, `Info.plist`, `scripts/dev-sim-entitlements.plist` | **REPLACE-IDENTIFIER** | team/profile/bundle/keychain group/reversed-OAuth scheme |
| `ios/App/App.xcodeproj/project.pbxproj`, `App/App/App.entitlements`, `BroadcastExtension/BroadcastExtension.entitlements`, `App/App/Info.plist`, `*Plugin.swift`, `BroadcastExtension/SampleHandler.swift` | **REPLACE-IDENTIFIER** | bundle ids, **App Group `group.com.wassup.meeting`** (see §6 App-Group risk) |
| `android/app/build.gradle`, `AndroidManifest.xml`, `res/values/strings.xml`, `com/wassup/meeting/` tree + `ACTION_*` constants | **REPLACE-IDENTIFIER** | namespace/applicationId/authority/app_name/url-scheme/package path |
| `capacitor.config.ts` | do-not-port | appId(4)/appName(5)/iOS scheme(20) |

No Android/iOS **signing secret** is tracked (no keystore, `.jks`, `.p12`, `.mobileprovision`).

---

## 6. Risks & decisions to carry into A2/A3

1. ⚠️ **ReplayKit broadcast extension is trapped in the Capacitor `ios/` target.** It is a §5 protected
   asset (on-device capture of another app's audio) but lives at `ios/App/BroadcastExtension/` +
   `BroadcastExtensionSetupUI/`. A3 says delete the Capacitor `ios/` target — **re-home this Swift into
   `apps/ios` first, don't delete it.**
2. ⚠️ **App Group retrofit.** `group.com.wassup.meeting` (Capacitor target + extension) must be renamed to
   the Algorythmos App Group **now** (A4) — A4 warns retrofitting App Groups breaks the recording handoff
   silently.
3. **`db-job` fate (§3.2)** — decide fold into `api` vs scheduled job; its handlers carry client payloads
   (`backfill-pr-d`, `debug-corpus`), so port structure, not data.
4. **Functions consolidation (§3.1)** — 5 handlers (`note-read`, `export-note`, `search-and-chat`,
   `shared-note`, `delete-account`) become `services/api` routes; keep Firebase triggers only where genuinely
   required (auth/Firestore). `firestore-mirror.js` in transcoder implies a dual-write to watch.
5. **Migration renumber** from `000`, dropping the two `seed-e2e-test-user*.sql` fixtures; `006_shares_hardening.sql`
   is the A10 share-links safety migration — verify it hashes token / adds mandatory `expires_at` + `revoked_at`.
6. **Design tokens** live in `src/index.css` (INTEGRANT) and `ios-native/.../Theme.swift` — rebuild in
   `packages/tokens`, don't copy (A6.5).

---

## 7. Licences (closed-source commercial — proprietary)

**Verdict: no blocking copyleft.** No package anywhere in the root or `functions` dependency trees is
licensed **solely** under GPL/AGPL/LGPL/SSPL/CC-BY-SA/EUPL. `services/*` depend only on GCP SDKs / express
/ pg / firebase-admin (MIT/Apache/ISC).

| Item | Licence | Assessment |
|---|---|---|
| `lightningcss` (+ platform binaries) | **MPL-2.0** | Weak, file-scoped; **build-time only**, not shipped → not blocking. |
| `dompurify` | MPL-2.0 **OR** Apache-2.0 | Elect Apache-2.0. |
| `jszip` | MIT **OR** GPL-3.0 | Elect MIT. |
| `node-forge` | BSD-3 **OR** GPL-2.0 | Elect BSD-3. |
| `junit` 4 (Android) | EPL-1.0 | **test-scope only**, never in the APK → not blocking. |
| `pdfjs-dist` / `mammoth` / `tesseract.js` (extraction deps → `services/extractor`) | Apache-2.0 / BSD-2 / Apache-2.0 | All permissive. No `ytdl`/YouTube dep exists (YouTube handled server-side in `transcoder/src/youtube.js`). |
| Bundled fonts: **Rajdhani** ×3 (`ios-native/.../Fonts/`, `OFL.txt` present) | **SIL OFL 1.1** | Embeddable/sellable in closed-source; **CLIENT brand choice → swap** for AlgoMinutes brand (branding, not licensing). Titillium/Saira/Roboto referenced but not bundled — all OFL/Apache. |

**Non-blocking housekeeping before ship:** record elected options for dual-licensed packages in a NOTICE
file; include the required Apache-2.0/OFL/BSD attributions; verify upstream MIT for `limiter` /
`exif-parser` (lock omits their `license` field).

---

## 8. Summary for A2/A3

- **Port (PLATFORM):** the pipeline (`services/*` incl. YouTube), `shared/*` (Gemini ladder, PII scrub,
  hybrid retrieval), `lib/*` + `db/migrations` (repo layer/schema), `server.ts` + the 5 Functions handlers
  (→ one `api`), the native iOS app (`ios-native/*`) **plus the re-homed broadcast extension**, the Kotlin
  audio layer (`android/.../*.kt`), the React web app (`src/*`), the test suite, the 4 `.claude/agents`
  checkers, and CI gates.
- **Generalise (MIXED):** rename the seven tokens; remove the `clinical` template/enum/copy; rebuild
  design tokens in `packages/tokens`; strip Capacitor glue; replace the plan-derived recording cap;
  externalise strings.
- **Do not port (CLIENT / CAPACITOR-ONLY):** Capacitor (`capacitor.config.ts`, `ios/` shell,
  `src/plugins/*`, `@capacitor/*`), all plans/ADRs/PROJECT/BLUEPRINT/DESIGN/README, `evidence/`, `evals/`,
  `reports/`, `scratch/`, `recordings/`, seed fixtures, client brand imagery/fonts, `.claude/skills/wassup-*`,
  `.firebase/` cache, and every regenerate-only credential file.
- **Regenerate fresh (A4):** all Firebase configs, new Apple team/profile/App Group, new Android package +
  keystore.
- **Act on now:** rotate + purge the Gemini key from source history (source-side, your decision); empty the
  gitleaks allowlist and add `.env*` coverage in the new repo (A2).

*End of A1.*
