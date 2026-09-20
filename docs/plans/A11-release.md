# AlgoMinutes → TestFlight → App Store: the serial PR train (rev 3 — loophole pass)

## Context

AlgoMinutes is a rebrand-extraction of `wasssup-meeting` (fork ≈ 2026-08-15). Track A1–A10 code is written
but **nothing has ever been built, deployed or signed**: iOS never compiled, no Cloud Run service exists,
staging is paused with an empty DB, prod was never provisioned, BUILD-PLAN **A11 is unstarted**.

Goal: a production recorder that reliably captures **2–4 hour meetings** and beats Otter/Granola/Fireflies on
robustness and intuitiveness. The audit shows a long meeting currently **fails at almost every hop**:

| # | Finding (evidence) |
|---|---|
| 1 | 2 h cap hardcoded, ignores entitlement (`RecorderService.swift:17`; `limits.ts:13` Pro = 4 h) |
| 2 | Single `.m4a`, `moov` only on clean stop → crash at min 170 loses everything (`RecorderService.swift:200,489`) |
| 3 | iOS calls `api/*`; server only mounts `/v1/*`; capture targets sync whole-file `process-audio`, not async `POST /v1/process` (`APIClient.swift:144…`) |
| 4 | Transcoder runs 12–18 ffmpeg+GCS+STT cycles in one request; no Cloud Run limits, no `dispatch_deadline` (`handler.js:151-191`, `main.tf:283`) |
| 5 | Upload 3600 s ceiling → restart from byte 0 forever on slow links (`UploadStallPolicy.swift:22`); resumable path gated off |
| 6 | Size caps disagree (50/120 MB); `storage.rules` not in repo |
| 7 | Queue names (`audio-jobs` vs terraform) and attempts (10 vs `isFinalAttempt` 5) mismatch |
| 8 | Summarizer single-call, throws on truncated JSON, flat 240 s; flat client `StuckBudgets`; no server sweeper |
| 9 | Embedder swallows failures → note `ready` but unsearchable, DLQ unreachable (`embeddings.cjs:125`) |
| 10 | Kickoff retry double-submits paid STT (`handler.js:175`); spend-cap silently drops jobs |
| 11 | `MODEL_LADDER` = `gemini-2.5-flash, 2.0-flash, 1.5-flash` (`intelligence.cjs:9`) — older rungs are likely retired on Vertex by now; **unverified** |
| 12 | Free = 120 min/mo and `FREE_FLOOR_MINUTES=null→0`: a 3 h test recording 402s unless trial/override works |
| 13 | No diarisation on Google path; no thermal/disk monitoring; no pause, bookmarks, Live Activity, live transcript, calendar, folders |

Apple: Team **`NY9MS8GSBK`**, ASC key **`457BNN593G`**, issuer **`6f9e67b0-fb28-401d-b347-2bd4ce854e2c`**, `.p8` at
`~/.appstoreconnect/private_keys/` (never in repo; ids via `ASC_KEY_ID`/`ASC_ISSUER_ID`/`ASC_KEY_PATH` env).
Xcode 26.5, xcodegen, gcloud, terraform installed. GCP trial credit (A$431) expires **14 Nov 2026**.

**User decisions:** broadcast extension ships wired; real IAP in sandbox from first (external) beta; staging for internal, prod before external testers.

## Rules of the train

1. **Strictly serial.** Branch off fresh `main` → one PR → CI green + evidence → squash-merge → next. Never two open PRs → no conflicts by construction.
2. **One PR, one concern**, target ≤ ~600 changed lines; each PR *owns* its files; later PRs extend, never re-shape. `RecorderService`'s public interface is frozen after PR-18 so PR-19…28 don't churn it.
3. **Evidence in every PR description** (query / log line / test output / device log) — CLAUDE.md §4.
4. **Audit callers before touching shared code** (`gemini-call.cjs`, `intelligence.cjs`, contracts). A contracts change updates **iOS + web + android** in the same PR and regenerates models.
5. After each PR run the matching sub-agents (`dual-write-auditor`, `pii-scrub-compliance`, `log-fields-auditor`, `silent-catch-detector`). New migrations only (expand/contract).
6. New bug found mid-PR → log in `docs/BLOCKERS.md`, don't widen the PR.
7. Branch protection may be unavailable on the org's plan (it was for wasssup) → fallback: port `wasssup-meeting/.githooks/pre-push`.
8. Human/calendar work runs in the **parallel track** (bottom), never blocking the train.

---

## Stage A — Foundation: make it build (PR-01 … PR-05)

**PR-01 `docs: A11 plan of record`** — commit dirty `DECISIONS.md`/`INFRASTRUCTURE.md`; add `docs/plans/A11-release.md`; ADRs: Apple ids/key handling; build number reset to `1` (new ASC record); broadcast extension in v1; billing-in-beta; 4 h entitlement cap via crash-safe capture; **"never hold a recording hostage"** (over-quota recordings are still processed, the *next* one is blocked); fill `A4-CHECKLIST.md`. Push `main`; protection or pre-push hook.

**PR-02 `build: first install, typecheck, codegen`** — `npm install`, fix typecheck, run contracts codegen, commit generated output. *Evidence: clean typecheck.*

**PR-03 `build: Dockerfiles resolve workspaces`** — solve `TODO(build A11)` vendoring once; all 8 images build; **boot-time env validation** in every service (fail fast on missing env — the wasssup "deploy silently defaults env" trap). *Evidence: 8 builds; missing-env boot test.*

**PR-04 `ci: typecheck, vitest, docker build`** — port ~24-file vitest suite from `wasssup-meeting/tests`; `ci.yml`. *Evidence: green run.*

**PR-05 `build(ios): first compile + tests green`** — `DEVELOPMENT_TEAM: NY9MS8GSBK`; fix compile errors; **guard `FirebaseApp.configure()`** when the plist is absent / under XCTest (tests are app-hosted and would trap) + CI stub plist; `ios.yml` path-filtered to `apps/ios/**` (macOS minutes are 10×), pinned Xcode, SPM cache. *Evidence: 161 tests green.*

## Stage B — Backend alive and long-recording-proof (PR-06 … PR-16)

**PR-06 `infra: Cloud Run, Scheduler, WIF, queues in Terraform`** — `google_cloud_run_v2_service` per service with **placeholder image + `ignore_changes` on image** (breaks the terraform/deploy chicken-and-egg); explicit limits (transcoder `3600s / 2 GiB / 2 cpu / concurrency 1 / max-instances cap`; summarizer `900s / 1 GiB`); env + Secret Manager refs managed here; `dispatch_deadline=1800s`; manage `activation_policy`; Scheduler; WIF pool + deployer SA for CI; Cloud NAT behind a variable (off until PR-28, cost recorded in DECISIONS). **Queue names:** code adopts terraform's; `maxAttempts` single-sourced. **Ops checklist:** resume staging (exact `--range/--network` commands), ADC as `gcp-admin@algorythmos.com`, record `terraform plan`, apply, `npm run migrate`. *Evidence: plan output, `\dt`.*

**PR-07 `ci: deploy-service workflow`** — reusable path-filtered: build → Artifact Registry → `gcloud run deploy --image` (staging on merge, prod on tag), plus `firebase deploy --only storage,firestore:rules`. Ops: deploy all 8; register staging Firebase iOS app, enable Apple/Google/anonymous. *Evidence: `curl /v1/health` 200 with `traceId` log line.*

**PR-08 `fix(ai): verified model ladder + Vertex smoke gate`** — audit every `gemini-call.cjs` caller; replace retired rungs with models verified live in the Vertex region; port wasssup's `check:vertex-schema` pre-deploy and `smoke:pipeline` post-deploy gates into the deploy workflow. *Evidence: smoke output per rung.*

**PR-09 `fix(storage): one upload cap, rules in repo`** — **export the currently deployed rules first** (don't regress unknown prod rules); commit `storage.rules`/`firestore.rules`/`firebase.json`; one constant in `limits.ts` (recording 256 MB ≈ 4 h + headroom; import 500 MB) consumed by rules, `StoragePaths.swift`, `UploadService` copy, `uploads.js`. *Evidence: emulator accept 200 MB / reject 300 MB.*

**PR-10 `fix(transcoder): per-chunk task fan-out`** — kickoff = probe + plan + upsert `audio_chunks` + enqueue one task per chunk with **deterministic task names `noteId-gen-idx`** (replay-safe); chunk task = extract → upload → STT submit, **skipping chunks that already hold `stt_operation_id`**; unknown duration → chunked, never fast path; per-chunk source fetch by ffmpeg `-ss` over signed URL (works because PR-18 writes moov-front files) with full-download fallback. *Evidence: replayed kickoff → identical row count + zero new LROs; 3 h fixture → all `transcript_lines` present, boundaries de-duplicated.*

**PR-11 `fix(summarizer): long-transcript map-reduce + salvage`** — above a token threshold: windowed section summaries (`redactPII` first, schema-constrained) → merge producing gist, **timestamped chapters**, decisions, de-duplicated action items with owners; works for **all 9 templates and `regenerate-summary`** (same code path); `salvageGeminiJson`; deadline scales with length; generation guard preserved. *Evidence: 27k-word fixture per template → valid JSON; pii sub-agent clean.*

**PR-12 `fix(embedder): batch, retry, fail loudly`** — batched Vertex predict, bounded concurrency + retry; rethrow → DLQ on final attempt; idempotent upsert. *Evidence: forced failure → `dead_letter` row; replay → no dup rows. **Full 3 h fixture end-to-end on staging within new 120/180-min budgets added to `PERFORMANCE-BUDGET.md`.***

**PR-13 `feat(jobs): stuck-note sweeper, spend-defer, honest progress`** — db-job re-drives/marks notes stalled past duration-scaled budgets; spend-cap trip → `deferred` + re-drive + refund (not silent drop); whole-file STT progress = elapsed/estimate. Migration `013`. *Evidence: staged stuck note recovered.*

**PR-14 `fix(api): retire sync process-audio`** — grep callers in web/android/iOS first; migrate them to `POST /v1/process`; remove or admin-gate the route. *Evidence: caller grep empty; web upload still works on staging.*

**PR-15 `feat(api): entitlement preflight + reconciled metering`** — `GET /v1/entitlement` adds `remainingMinutes`, `maxRecordingSeconds`; kickoff reserves minutes from client duration, **transcoder reconciles to probed duration** (idempotent key `noteId:ingest`); over-quota policy per PR-01 ADR; verify reverse-trial grants to **anonymous guests**; db-job `grant-entitlement` for internal testers (so M1's 3 h test can't 402). Contracts bump → all three clients. *Evidence: metering row = probed minutes; tester grant row.*

**PR-16 `feat(api): resumable uploads + rate limits`** — finish `/v1/uploads` GCS resumable sessions (object lands at the same path `/v1/process` expects); rate limits on chat/search/uploads/webhooks in one middleware. *Evidence: kill-and-resume integration test; 429 test.*

## Stage C — iOS core: a recorder that cannot lose a meeting (PR-17 … PR-24)

**PR-17 `fix(ios): API client speaks /v1`** — all paths from contracts; capture → `/v1/process`; billing origin; upload-session paths; `X-AlgoMinutes-Client`; **426 please-update** screen; per-request timeouts; `Staging`/`Release` xcconfigs + per-env `GoogleService-Info.plist` build phase; **transcript paging via `/v1/notes/read`** (Firestore mirror caps at 200 lines) with lazy list. *Evidence: contract test per route on staging; 3 000-line transcript renders fully.*

**PR-18 `feat(ios): crash-safe capture engine up to 4 h`** — the centrepiece. Step 1 (time-boxed spike, same PR, harness kept as tests): choose by measurement between **(A) `AVAudioEngine` tap → rotating finalized AAC files + lossless passthrough concat** and **(B) `AVAssetWriter` fragmented-MP4 segments (init + media segments on disk)**. Acceptance criteria decide, not preference: zero sample loss across boundaries (sine-sweep continuity test), survives `kill -9` losing ≤ 10 s… ≤ 1 segment, runs backgrounded + locked for 4 h, buffers can also feed on-device speech (PR-33) and be produced by the broadcast extension (PR-29). Output file is **moov-front / network-optimized** (seekable streaming for server and player). Disk check = 2× projected size at start **and continuously**; segments deleted only after the final file validates. Cap from cached entitlement — **recording is never blocked by being offline**; quota preflight is advisory. Owns `RecorderService`, `RecordingStore`, `RecordingValidator`, new `CaptureEngine/*`. *Evidence: unit tests (rotation, continuity, recovery); device kill-test at min 30 recovers ≥ 29 min.*

**PR-19 `feat(ios): interruption/route hardening port (ADR 0009)`** — hand-merge from `wasssup-meeting/ios-native/Wassup/Services`: `InterruptionPolicy`, hold/reset handlers, `mediaServicesLost`, watchdog + `isRecorderRunning` deltas (pure policy objects slot onto the new engine); thermal back-off of metering, low-battery + low-disk warnings. Port tests. *Evidence: device R-cases (call, Siri, AirPods drop, media-services reset).*

**PR-20 `feat(ios): uploads that always finish`** — enable `BackgroundUploadService` on PR-16 (survives kill/reboot, persisted offset); size-scaled stall policy, no wall-clock ceiling; cancel-and-join registry (wasssup); Wi-Fi-only option; `StuckBudgets` scale every phase by duration; Firebase `putFile` kept as fallback only. *Evidence: airplane-mode mid-upload → resumes from offset; 200 MB on throttled link completes.*

**PR-21 `fix(ios): identifiers, entitlements, push`** — new Google reversed-client-id; register `algominutes://`; App Group + `aps-environment`; FirebaseMessaging; fix `.gitignore` fetch command; CI grep for `909388484461`. *Evidence: grep empty; push token log line; push-to-note deep link opens.*

**PR-22 `feat: bookmarks + pause`** — manual pause/resume; one-tap bookmark stored **in the recording sidecar offline**, synced on upload (migration `014 note_bookmarks`, repo, `/v1/notes/:id/bookmarks`), rendered in transcript, passed to summarizer as emphasis. Contracts → three clients. *Evidence: bookmark rows after offline recording.*

**PR-23 `feat(ios): Live Activity + Dynamic Island`** — widget extension target (4th bundle id, App Group), `Text(timerInterval:)` timer, pause/bookmark intents. *Evidence: device video, locked 30 min.*

**PR-24 `feat(ios): follow-up sender + long-note playback`** — port `FollowUpSender`, `MailAppAvailability`, `LSApplicationQueriesSchemes` (latent Bug 57); streamed playback with seek for 3 h files. *Evidence: tests; seek to 2:45:00 < 2 s.*

## Stage D — Release tooling → **M1 internal TestFlight** (PR-25 … PR-26)

**PR-25 `build(ios): release script + ASC setup`** — port `ios-native/DEPLOY.md` → `apps/ios/DEPLOY.md` + `scripts/release.sh` (xcodegen → archive → export/upload, committed `ExportOptions.plist`, automatic signing + `-allowProvisioningUpdates` for **all bundle ids**, ASC key auth, **pre-flight refuses duplicate build number**); port `scripts/asc-setup.mjs` (app record, metadata regex-read from `STORE-LISTING.md`, beta groups, subscription group + products); port runbooks (`apple-tilt-checklist`, `rollback`, `release-protocol`, `device-tests-recording` + segment-recovery / 4 h soak / ReplayKit / IAP cases); `.storekit` config; paywall entry points **flag-hidden until PR-27**.

**PR-26 `chore(ios): 1.0.0 (1)`** → **M1**. *Exit evidence on a real iPhone: guest → **3 h locked-screen recording** with a phone call in the middle → upload over cellular → transcript + chaptered summary; single `traceId` across services; psql rows in `notes/transcript_lines/summaries/embeddings`; search + chat find minute-170 content; delete account → rows gone in PG and Firestore.*

## Stage E — External-beta gates → **M2 external TestFlight** (PR-27 … PR-32)

**PR-27 `feat(billing): Apple verification + live paywall`** (server then client in one concern: "purchases work") — JWS x5c chain → Apple Root CA G3; ASSN V2; idempotent upserts; reconciliation + trial-expiry jobs; **prod must honour `environment=Sandbox` transactions** (TestFlight *and App Review* purchase in sandbox against the production build) flagged `sandbox=true`, both ASSN URLs configured; iOS live products, restore without sign-in, auto-renew disclosure; provisional `FREE_FLOOR_MINUTES`, finalised from measured cost/min. *Evidence: forged JWS rejected; sandbox purchase → row; restore on fresh install.*
**PR-28 `feat(transcoder): diarisation go-live`** — gated on DPA + paid opt-out: enable NAT egress, shadow eval, flip `STT_PROVIDER=assemblyai`, Deepgram inline path made async or disabled, talk-time per speaker stored; **iOS speaker-rename chip** lands here (tags are null before this). *Evidence: DER gate report; `note_speakers` row.*
**PR-29 `feat(ios): system-audio capture`** — `RPSystemBroadcastPickerView`; extension encodes AAC streaming into App-Group segments (**50 MB extension memory limit** — no buffering), reuses PR-18 segment format; consent gate; honest copy; review-notes justification; `project.yml` kill-switch. *Evidence: device handoff log, 60 min capture.*
**PR-30 `fix(api): single deletion path + tenant tests`** — consolidate; Bug-62 dual enumeration via repo layer; two-account leakage test in CI; retention enforcer. *Evidence: queries from both accounts.*
**PR-31 `infra: prod + observability`** — provision `algominutes-prod`, budgets scoped, PITR; dashboards + alerts (failure rate, DLQ depth, p95 time-to-summary, spend, crash-free) **before** both envs run concurrently; spend-breaker drill; **backup restore drill**.
**PR-32 `feat(web): marketing + legal site`** — `/`, `/support`, `/privacy`, `/terms`, `/delete-account`; fix `apiUrl.ts`. → **M2** after the device matrix (2 iPhones × 2 iOS: call/Siri/lock/force-quit/airplane/low-disk/thermal, 4 h soak).

## Stage F — Beat Otter, then ship (PR-33 … PR-38)

**PR-33** live on-device transcript preview (`SFSpeechRecognizer`, `requiresOnDeviceRecognition`, fed from PR-18 buffers; usage string) · **PR-34** calendar-aware meetings (EventKit: one-tap record, auto title, attendee → speaker suggestions, action items → Reminders) · **PR-35** folders, tags, global search (migration `015`, workspace-scoped) · **PR-36** intelligent note detail (chapter nav, tap-to-seek, talk-time chart, bookmark rail, ask-AI presets) · **PR-37** server-side DeviceCheck · **PR-38** store submission (screenshots 6.9"/6.5", true dark icon, `STORE-LISTING.md` on the wasssup copy-pack template, labels, age rating, review notes + demo account, full `BUILD-PLAN.md:615-644` checklist) → **M3 phased release**, crash-free threshold halts rollout.

Post-1.0: progressive segment upload (near-live transcript), Zoom/Meet/Teams bot, Slack/Notion/CRM, team workspaces, Android Track B, UI i18n.

---

## Parallel non-code track (start now)

- Rotate exposed upstream Gemini key (urgent). Confirm `algominutes.com` DNS; support@/privacy@ mailboxes.
- Legal: ToS + Privacy, recording-consent opinion (APP 8), AssemblyAI **paid account + opt-out + DPA** (gates PR-28).
- ASC: Paid Apps agreement, banking/tax, **Small Business Program before first sale**, both ASSN URLs, privacy labels.
- Brand: palette/typeface, screenshots, dark icon.

## Verification summary

| Milestone | Proof |
|---|---|
| Stage A | CI green: typecheck, vitest, 8 docker builds, iOS tests |
| Stage B | migrations in psql; ladder smoke; 3 h fixture end-to-end within budget; replay → no dup rows/LROs; forced failures in `dead_letter` |
| Stage C | continuity/recovery tests; device kill-test; resume-from-offset log |
| M1 | real 3 h locked-screen recording with interruption → chaptered summary, one `traceId`, deletion by query |
| M2 | sandbox purchase on prod backend; forged JWS rejected; restore drill; device matrix; legal URLs; leakage test |
| M3 | BUILD-PLAN checklist evidenced; approval; rollout metrics |

## Risks

- First compile (PR-02/05) may balloon — mechanical fixes only, log the rest.
- PR-18 is the hardest item; the spike + acceptance tests exist so the choice is proven, not assumed.
- Broadcast extension = top App Review risk → kill-switch.
- Trial credit ends 14 Nov 2026; alerts (PR-31) precede dual-env spend.
- Anything I could not verify is marked so (model availability, deployed storage rules, org branch-protection) and has a PR step that verifies it first.
