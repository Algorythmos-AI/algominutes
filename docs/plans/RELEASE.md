# Release plan: a great beta on iPhone and Chrome, then production ready (rev 11, 2026-09-30)

> Rev 11 was approved by the owner on 2026-09-30 and leads this file: it re-orders the remaining work around
> robustness, long meetings and ease of use. The rev 10 sections after it (approved 2026-09-29) keep the detail of
> each wave; where they disagree, rev 11 wins. Update this file in the PR that changes the plan. Evidence for each
> step goes into `docs/BLOCKERS.md`.

## Rev 11 (2026-09-30): robust, easy, and built for long meetings

> Approved by the owner on 2026-09-30. Rev 11 re-orders the remaining work around five audits plus a line-by-line
> re-check at integration `078fe43`: the server pipeline, iOS, web/infra/e2e, a 1–4 hour meeting traced through
> every layer, and a first-time user's walk through both apps. **Where this section and the rev 10 sections below
> disagree, this section wins.** The rev 10 waves, their PR tables and proofs still hold as the detail of what
> each wave ships. Evidence for each item goes into `docs/BLOCKERS.md` §0.

**Decisions taken on 2026-09-30:**
- **A recording over the minutes left is held, never refused.** Its audio is kept, the note waits in "Waiting
  for minutes", and it processes by itself when minutes arrive.
- **Quality first.** Cohort 1 waits for every P0 gate: about **2026-10-24**, not 10-10 to 10-13. The Gemini
  proof date (10-15) stays pinned regardless.

### R11.1 Looking back: the loopholes in how we work

38 PRs merged since rev 10 (#250–#288). What went wrong, and the rule from now on:

| # | Loophole | What it cost | Rule |
|---|---|---|---|
| 1 | Merges were tracked, not deploys | **Every staging deploy since #280 (2026-09-30 01:02 UTC) has failed.**<br>• #280: `ci-gate` stopped it, because `ci.yml` went red on `integration` after the merge queue had passed it. A flaky test: `apps/web/src/app/settings/settings.test.tsx:135-147` calls `answer()` before the mocked fetch has run.<br>• #281 onward: `rollout (billing)` fails, since billing requires `BILLING_URL` and `JOBS_SA_EMAIL`, which only Apply B sets.<br>So `rollout-api`, `rollout-meetings` and `smoke` are skipped, and the api is stuck on 539ad93. | **A merge is done when staging runs it.** The train follows each deploy; a red deploy stops the line. |
| 2 | One service's boot failure freezes all the others | `deploy-staging.yml:176` builds with `fail-fast: true`. Waves 2–3 (`rollout-meetings`, `rollout-api`, `smoke`) need all of wave 1 (`:289-291,313-316`). | The api waits only on the services it calls |
| 3 | Boot-fatal config merged before its apply | The same outage | New config is **fail-soft until applied**, and a deploy preflight checks the **live** revision's env |
| 4 | Safety nets merged but never switched on | • The nightly e2e ran once, and failed without `E2E_INVITE_CODE`.<br>• The `e2e` job of web-e2e has been skipped in every run (no `VERCEL_AUTOMATION_BYPASS_SECRET`, or a red deploy). | A safety net is closed by its **first green run**, not by its merge |
| 5 | Nothing has reached a tester | `main` is 90 commits behind; 0 of 11 Wave 1 proofs recorded | Stage 1's gate is testers using the app |
| 6 | Long meetings have never run | The chunked path (over 10 min) hasn't run on staging in 30 days. The weekly 180-minute e2e has never run, and its only fixture is a 9-second Ogg clip, looped: never WebM (Chrome) or ADTS (iPhone). | A duration is supported only once it's proven, by e2e and on a device |
| 7 | Failure paths untested end to end | The P0s below live in long-merged code. The iOS upload loop has **no tests at all**. | Every fix starts with a failing test; the nightly gains failure cases |
| 8 | Your queue of steps grows faster than it drains | About 20 open | One ordered list per stage (R11.5) |

### R11.2 Where we stand, and how far from the target

| Target | Code | Live | Proven | Blocked on |
|---|---|---|---|---|
| **Wave 1:** iPhone and Chrome, invite codes | Built, less the P0s in R11.4 | Staging stale since #280; no beta host | 0 / 11 | The P0s, Apply B, the e2e secrets, the Vercel beta, P1, Staging → Beta, Beta App Review |
| **Wave 2:** notetaker, Pro in the sandbox | About 90%; 24, 25, 29 queued | Not applied | 0 / 8 | Apply B, Recall, Apple products and keys, Stripe test keys, the legal opinion on bots |
| **Wave 3:** extension | Built (33a–38 queued); 33b paused | None | 0 / 4 | Your go-ahead on 33b, Apply C, store review |
| **Prod-ready** | 39a and 40 queued; the rest of 39, and 41, not started | No prod | None | Apply P, prod Firebase, P3 |
| **App Store 1.0** | 8 blockers (A1–A8) | None | None | The decisions (R11.9), the listing, legal |

**Dates** (if your Stage 0 steps happen this week):
- cohort 1 about **10-24**;
- Wave 2 about mid-November;
- the extension late November to early December;
- 1.0 submission-ready about mid to late December.

**Fixed dates:**

| Date | Event | Guard |
|---|---|---|
| 10-15 | A real 45–60 minute meeting summarised on **gemini-3.5-flash alone** | `gemini_ok` must name gemini-3.5-flash with `finishReason: STOP`. A fallback to 2.5 is not proof for after 10-20. |
| 10-20 | gemini-2.5-flash retires. `activeLadder()` (`packages/ai/src/models.cjs`) drops it automatically, leaving **one model, no fallback**. | H8 merged first; a second rung from spike S1, or the risk recorded in DECISIONS |
| 11-14 | The GCP credit ends; staging runs on real money | Budget alert verified before then |
| 12-06 | Domain renewal | Your calendar |

### R11.3 The bar: what "great" means, in numbers

Measured from Stage 2 on; every gate checks them.

| Measure | Target | Source |
|---|---|---|
| Recordings that reach **ready, "waiting for minutes", or a retryable error** | ≥ 99%. None lost, none spinning forever. | `upload_sessions` joined to `notes` (daily digest) |
| **A meeting is one note:** splits caused by an interruption | 0 | iOS `recording_interrupted` / `recording_resumed` pairs |
| Time to notes, from `notes.queued_at` | 1 h ≤ 10 min, 2 h ≤ 15 min, 4 h ≤ 25 min (p95) | `summarizer_complete.timeToSummarySec`. `docs/SLO.md` objective 4 (half the length + 5 min) is tightened in the PR that changes the code's `time_to_summary_slo_missed` objective, so the doc and the alert never disagree. |
| Stop → uploaded, on Wi-Fi | 1 h ≤ 2 min (p95) | `upload_complete` minus the client's stop time |
| Longest meeting | **4 h on Pro, trial and invite; 2 h on free** (`packages/contracts/src/limits.ts:12-14`), each proven on iPhone, web, extension and notetaker | e2e and device proofs |
| Crash-free users | ≥ 99.5%, **counting jetsam, hang and background-task kills** | Crashlytics plus MetricKit (H15) |
| Taps from Home to recording | **2** after the first run (today 4; 5 on first run) | XCUITest |
| Open P0/P1 at a gate | 0 | BLOCKERS |
| Reds on `integration` after the merge queue passed | 0 unexplained; each fixed the same day | CI |

### R11.4 What's broken, by pillar

Every item is reproduced by a failing test before it's fixed, or closed with evidence if it doesn't reproduce. All
were verified in the code on 2026-09-30.

**Pillar A: nothing lost, stuck, doubled or double-paid (P0)**

| ID | Problem | Where | PR |
|---|---|---|---|
| L1 | Staging deploys fail (loopholes 1–3) | `services/billing/src/env-spec.cjs`, `deploy-staging.yml` | Apply B, H0, H1 |
| L2 | **A note can spin forever.** iOS deletes the recording after upload but before `/v1/process` is accepted (`AppEnvironment.swift:394` before `:397-405`; also `reupload` `:614`). If the app dies there, the note stays "processing" with no Postgres row. The sweep never sees it (`listStuckNotes` is Postgres-only), and Try again is offered only on an error. The audio is safe in GCS. | iOS; `notes-repo.ts:1098-1111` | H2 (server), H3 (iOS) |
| L3 | **Trying again doubles a long note's transcript**, and the summary and embeddings are built from the doubled text. A Cloud Tasks retry is safe; it's a second `markQueued` (a user's Try again, or the 3 h stale re-queue, `notes-repo.ts:265`) that deletes the chunks (`:430`) while their lines survive with `chunk_id NULL` (`001_init.sql:90`, a partial unique index). Each re-run also re-pays all speech-to-text. | `notes-repo.ts`, `pipeline-repo.cjs:309-311` | H2 |
| L4 | Chat and search are uncapped: no length limit in the contract (`z.string().min(1)`), no `generationConfig` on chat (`search-and-chat.cjs:506-512`), no quota or spend count, only 120 requests a minute | `search-and-chat.cjs`, `contracts/.../{chat,search}.ts` | H9 |
| L5 | Pipeline work can be dropped: 5 attempts in about 75 s for transcode, embed and notify (`main.tf:396-426`); lost kickoffs and polls aren't re-driven; the sweep's *absence* isn't alerted | `main.tf`, `redrive-repo.ts`, `sweep.js` | H7 |
| L6 | **No lease on the kickoff.** The transcoder's 3600 s timeout outlives the 1800 s dispatch deadline, so a long kickoff (extracting 24 chunks for 4 h) can be delivered again while it's still running. Both can start speech-to-text for the same chunk before either saves its op id (`handler.js:385-397`). Minutes are safe (advisory lock plus ledger key); Google is paid twice. | `cloud-run.tf:30,55`, `transcoder/src/handler.js` | H2, H7 |
| L7 | A zero-second claim passes the quota check; YouTube downloads are unbounded; nothing caps a user's notes in flight | `kickoff.ts:~198`, `youtube.js` | H2 |
| L8 | A captured call can land in another account on the same phone: sign-out never clears the App Group (`AppEnvironment.swift:249-264`) | iOS | H11 |
| L9 | After any consent earlier in the session, a Control Center capture uploads with no prompt (`ConsentGate.swift:52-64`, a per-process flag) | iOS | H11 |
| L10 | "Leave the app, you'll get a notification" isn't reliable: the completion handler runs before complete and kickoff (`BackgroundUploadService.swift:312-316`); the orphan path's background task has no expiration handler (`AppEnvironment.swift:98`) and the in-process path has none; a cold background launch runs before auth is ready (`:285`) | iOS | H3 |
| L11 | Uploads:<br>• a second caller replaces the first one's continuation, so the first hangs (`BackgroundUploadService.swift:246-259`);<br>• a 308 on the final chunk counts as success (`:303-309`);<br>• Wi-Fi-only waits silently (`:89-91`);<br>• **stuck uploads never time out**: `UploadStallPolicy` is tested but never used, and the resource timeout is 7 days;<br>• imports aren't durable (`ImportSheet.swift:84,122`) | iOS | H3 |
| N1 | **A phone call longer than 5 minutes ends the recording**, so one meeting becomes two notes, or loses its second half. The watchdog gives up at 300 s (`RecorderWatchdog.swift:38`); an `.ended` interruption without `.shouldResume` stops at once (`RecorderService.swift:643-647`). | iOS | H4 |
| N2 | **Speech-to-text runs in `locations/global`, not Sydney** (`stt.js:~96-101`, `STT_RECOGNIZER` unset), against the residency decision (DECISIONS A4) that `models.cjs` enforces for Vertex | transcoder | S1, H10 (before any external tester) |
| N3 | **The web caps a Pro user at 2 h** when its one plan fetch fails: it starts at the free cap and never retries (`RecordPage.tsx:106,170-177`) | web | H5 |
| N4 | Broadcast: a new capture **deletes the unclaimed previous one** (`SampleHandler.swift:~104`); the extension's `.m4a` is unreadable if the extension is killed, and the app then deletes it (`BroadcastHandoff.swift:135-137`); `finishWriting` doesn't check `writer.status`; no cap or disk check | iOS extension | H11 (P0 if broadcast ships in the beta) |

**Pillar A (P1)**

| Area | Items | PR |
|---|---|---|
| iOS recording | `record()`'s result unchecked in `start()` (`RecorderService.swift:236,252`); the clock loses time after a watchdog or route restart (`:454`) | H4 |
| iOS accounts | A guest's pending recordings lost on an account switch; 401 `account_deleted` unhandled; sign-out leaves the cache, playback and the entitlement | H11 |
| iOS failures invisible | No MetricKit, so jetsam, hangs and background-task-expiry kills aren't counted; no non-fatals; no crash reporting in the broadcast extension | H15 |
| Purchases | The paywall shows success when the server rejected the purchase; a Pro user out of minutes loops | H17 |
| Push | Registers only after a first recording; the pre-prompt shows on every launch | H17 |
| Logs | The player's error description may carry the signed URL (`AudioPlayerService.swift:125`) | H17 |
| Search | Returns embeddings from notes in error | H9 |
| Embedding | `wordsToLines` has no length cap. A line over 2,000 characters becomes an oversized chunk, a batch 400s, and the note is permanently unsearchable. | H10 |
| Transcoder memory | Up to 500 MB is downloaded into in-memory `/tmp` in a 2 GiB service (`ffmpeg.js:141-145`) | H7 |
| Money | One tester can exhaust the global daily cap; the spend guard fails open, unalerted; chat isn't counted; the prod cap is unset | H9, H23 |
| Stripe | A second checkout creates an untracked subscription; a partial refund revokes Pro; events out of order; the webhook's API version; secrets outside Terraform | H21 |
| Security | Share links can't be revoked; 10 of 12 service accounts can read every secret; the unused extractor has `objectAdmin` on all three buckets and has no dead-letter path, and nothing enqueues to its queue | H20, H22 |
| Observability | Alert emails exist (two channels), but there's no alert for sweep absence, queue age, scheduler failures, Cloud SQL CPU and connections, or Gemini truncation (`gemini_output_truncated` is logged, not alerted); no paging | H7, H8, H22 |
| Scale (100 testers) | Staging api max 1; 2 transcoders shared by polls and kickoffs; `db-f1-micro`; no pool acquire timeout | H23 |

**Pillar A (P2, tracked in BLOCKERS):**
- the upload size isn't enforced at `/complete`;
- notes that live only in Firestore are outside retention and backups;
- no full re-mirror after a PITR;
- the sweep's step order doesn't fit its 900 s limit;
- deploys have no canary;
- CORS allows localhost, `capacitor://` and `ionic://` in every environment, prod included (`packages/ai/src/cors.cjs:16-22`; credentials are off, so low risk, but fixed before prod);
- share-link IP hashes are unsalted;
- yt-dlp is unpinned;
- code-scanning alert #131.

**Pillar B: long meetings, 1 to 4 hours, every time**

| Layer | Today | 1 h | 2 h | 3 h | 4 h |
|---|---|---|---|---|---|
| Length check (server) | `durationSec > maxSec` and `measuredSec > maxSec`, with zero slack (`kickoff.ts:~228`, `measured-length.ts:~91`) | ok | ok | ok | **fails** |
| Over the minutes left | Refused, with a refund, after the meeting (`transcoder handler.js:230-251`); notetaker notes are exempt | at risk | at risk | at risk | at risk |
| iOS interruptions | A call over 5 min ends the recording (N1); the clock loses time (`RecorderService.swift:454`) | at risk | at risk | at risk | fails |
| Speaker labels | The long path uses the system recognizer, with no diarization: every line over 10 minutes says "Speaker" | poor | poor | poor | poor |
| Summary | One call, a 16,384-token cap shared with **uncapped thinking**, and a 240 s total budget (`intelligence.cjs:8`). Chapters come last and are the first thing cut. | ok | ok | at risk | at risk |
| Web recording | 2 h cap until the plan loads (N3); a retry after 5 failures restarts from byte 0 (`importAudio.ts:102-106`); Chrome's WebM has no seek index; laptop sleep ends capture (the wake lock only holds the screen); no mic meter outside call mode | ok | at risk | at risk | fails |
| After the meeting | The iOS audio link expires after 15 min and is never refreshed (`AudioPlayerService.swift:65,84-86`). Exports read the 200-line Firestore mirror. | at risk | at risk | at risk | at risk |
| Capacity | 2 transcode slots shared by kickoffs and 60 s polls | ok | ok | at risk under load | at risk |

Not a risk (checked): the Firestore 1 MiB document limit. The mirror caps a transcript at 200 lines
(`firestore-mirror.js:43-56`), and the full transcript lives in Postgres.

| ID | Fix | Proof |
|---|---|---|
| LM1 (P0) | Accept a recording that hits the limit: 60 s of server slack, with the charge capped at the plan's limit; the apps stop 5 s early; the web rounds down; the web retries the plan fetch and never stops a recording because the plan is unknown | A 240-min charge measured at 14,400.3 s is accepted and charged 240 min. A failed plan fetch doesn't stop a Pro recording at 2 h. |
| LM2 (P0) | **A meeting is one note.** An interruption pauses, for as long as the call lasts (up to the cap), and never stops. A failed reactivation starts a new segment of the same file; ADTS frames concatenate byte for byte. The clock banks time before every restart. | XCTest: a 20-minute interruption, an `.ended` without `shouldResume`, and a watchdog restart each give one file with the right length |
| LM3 (P0) | **Prove it.** Real, non-repeating speech at 60, 120, 180 and 240 min, in **ADTS and WebM**. Nightly 60, weekly 120/240, and a manual dispatch for the gate. | ≥ 8 chapters, the last past 75% of the recording; no salvage; no dead letters; time to notes within R11.3. Plus the 3 h locked-screen device run with a 30-minute call in the middle. |
| LM4 (P1) | Room for long summaries:<br>• a thinking cap (the parameter name from S1: the 3.x family uses `thinkingLevel`);<br>• a 32–65k output cap when chapters are asked for;<br>• the ladder's time budget scaled by transcript length;<br>• `finishReason` and token counts logged, and the truncation alert;<br>• the fast path gets the summarize queue's retry window;<br>• chat gets a `generationConfig`. | A real 3 h transcript summarised in Sydney |
| LM5 (P1) | Speaker labels on long recordings. S1 finds a diarization-capable recognizer in `australia-southeast1`; if none, the AssemblyAI switch (D7) is your call (US processing, a privacy change). | 2- and 3-person fixtures: speaker changes found; rename works |
| LM6 (P1) | Minutes are never a surprise: held-for-minutes (H6); minutes left on the record screen; a warning when a recording passes them; the notetaker's remaining time; the invite docs match the code | XCTest and vitest per state |
| LM7 (P1) | After the meeting: iOS refreshes the audio link and exports the full transcript paged from the api; web recordings get a seekable AAC rendition iOS can play | Play past 20 min; seek to the last chapter of a 3 h note on both clients |
| LM8 (P1) | Web uploads: a retry resumes the same upload session. 33b (uploading while recording) resumes with your go-ahead. | Kill the network mid-upload on a 2 h file: it resumes, with one note |
| LM9 (P2) | Capacity: speech-to-text polls on their own queue; more transcoders (H23) | The load test (31): 10 two-hour notes at once, all within the target |
| LM10 (P2) | Chat on a long note also sees the summary and chapters | A chat eval on a 3 h note |

**Pillar C: easy for people to use**

The foundations are good: a guest records without signing in, recordings are protected, progress is honest, and
the web catches a tab shared without audio. The friction around them:
- 4 taps before every recording (Home → Continue → tick → Start), and a Ready step that adds nothing;
- a naming sheet after Stop that can't be skipped and has no Discard. Killing the app there leaves a file with no
  note (the comment at `RecordingView.swift:26-28` is wrong);
- the back arrow **stops** the recording (`RecordingView.swift:38-39`);
- no pause;
- Home never shows your notes;
- three places delete without asking;
- raw error codes;
- on the web: no Try again on a failed note, and no mic meter outside call mode.

| # | Change | Where | Effort |
|---|---|---|---|
| UX1 | Confirm or undo every delete (swipe and long-press in Files, web Discard, the retention change); destructive actions in red | `FilesView.swift:247-259`, `NoteActions.swift:54-62`, `RetentionSettingsCard.swift:100-116`, `RecordPage.tsx:524` | S |
| UX2 | One consent sheet, full height and scrollable, with Start pinned (also fixes a likely hidden Start on an SE at large text) | `RecorderFlow.swift:27-69` | S |
| UX3 | No forced naming after Stop: straight to the note, auto-titled (`TitleDeriver`), with a confirmed Discard; one title rule for iOS, web and captures | `RecordingView.swift:209-221` | S |
| UX4 | Back minimises and never stops; Pause/Resume; "Paused for your call" | `RecordingView.swift:37-46`, `RecorderService.swift` | M |
| UX5 | Home shows recent notes with live status ("Uploading 40%", "Ready in about 3 min") and the example note; the account prompt waits until a summary has been read | `HomeView.swift`, `FilesView.swift`, `BillingService.swift:214-225` | M |
| UX6 | Web: Try again on failed notes; a mic meter and silence warning in **both** modes (reuse `callCapture.ts`'s meter); `displaySurface: 'browser'` and call tips; "keep the lid open and plug in" for recordings over 1 h; move `index.css:78`'s unlayered `p, span, li` rule into `@layer base` (today it beats every Tailwind colour utility: the red "● RECORDING" at `RecordPage.tsx:448` renders in the body colour) | `NoteDetailPage.tsx:213-217`, `RecordPage.tsx`, `callCapture.ts:63`, `index.css:78` | S–M |
| UX7 | Plain words everywhere: server and system codes mapped to sentences (reusing the web's `lib/api/errors.ts`); one vocabulary on both apps (Record, Stop, Notes, Getting started, Couldn't process, Summary, Transcript, Ask); an estimate while processing | `ChatView.swift`, `APIClient.swift:33`, `ProcessingPane.swift` | S |
| UX8 | Search finds transcript words as you type, doesn't say "no match" before it has searched, and opens a result at the moment it matched | `FilesView.swift`, `ChatView.swift` | S |
| UX9 | Chat answers you can use: Copy, Share, Open in Mail for the follow-up; 3 starter questions; "Ask about this meeting" | `ChatView.swift` | S |
| UX10 | Minutes are clear: one server figure, a bar and the reset date; the invite code always on the paywall; an automatic retry after redeeming | `SettingsView.swift`, `PaywallView.swift` | S |
| UX11 | "Record a call (Zoom, Teams, Meet)" as its own entry, with 3 numbered steps and "turn Microphone on" | `RecorderFlow.swift:83-129` | S |
| UX12 | The note screen: the summary first, duplicate tiles removed, Edit summary on iOS, speaker rename by tapping the name, find in transcript, checkable action items | `NoteDetailView.swift`, `TranscriptPane.swift`, `SummaryPane.swift` | M |
| UX13 | Accessibility: `Theme.tertiary` (about 3.0:1, `Theme.swift:45-46`) → `Theme.muted` for readable text (`LoginView.swift:98`, `HomeView.swift:243`, `SettingsView.swift:326`, `ChatView.swift:147`); 44 pt targets; Reduce Motion on the Home dot; VoiceOver values and announcements; focus handling in the web dialogs | iOS, web | S |

**The "wow" features, recommended before 1.0** (decision 3):
- **Live Activity and Dynamic Island**, about a week. Timer, pause, stop and bookmark from the lock screen. There is no widget target today, so this is a new extension target.
- **Bookmarks while recording**, about a week. A marked moment shows in the transcript and guides the summary.
- **A follow-up ready to send**, 3–5 days. Action items by owner, opened in Mail.

After 1.0: calendar-aware titles and attendees, and a live transcript.

### R11.5 How bugs stay out

1. **Definition of done, for every PR:**
   - a failing test first, then the fix;
   - a mutation check that reverts the fix and turns the test red (with a no-op control);
   - the CLAUDE.md sub-agents;
   - two-account tenancy tests for new queries, and a replay test for new async handlers;
   - evidence in the PR body.

   A PR is **done when staging runs it**: deploy green, every image at the head, smoke passing.
2. **The train** (`scripts/train.sh`, H1b) follows each merge to its deploy and smoke, and stops the line on red.
   One PR open at a time. No attribution.
3. **Flake policy:**
   - A red on `integration` after the merge queue passed is a P1, fixed that day and never retried away.
   - A new async UI test runs 20 times locally before its PR.
4. **Config never boots fatal before its apply:**
   - new required env is fail-soft (`<service>_config_missing`) until Terraform sets it;
   - the preflight compares each service's `env-spec` with the live revision.
5. **A safety net is closed by its first green run**: the nightly e2e, web-e2e, and each alert (fired once as a test).
6. **The nightly gains failure cases:**
   - a replayed kickoff;
   - a Try again that must not double;
   - an over-quota hold and release;
   - an interrupted upload.
7. **Kill switches are drilled:** `broadcast_capture`, `notetaker_surfaces`, the paywall, `shareLinks`, chat. Each is
   flipped on staging once in Stage 2, with the client behaviour recorded.

### R11.6 The plan, by stage

#### Stage 0: stop the line (10-01 → 10-02)

| Step | What | Closes |
|---|---|---|
| **H0** `test(web)` | The settings test waits for the mocked fetch before `answer()`; 50 repeats green | Loophole 1 |
| **H1** `fix(billing,ci)` | • Billing boots without `BILLING_URL`/`JOBS_SA_EMAIL`, logs `billing_config_missing`, and refuses only the tasks that need them.<br>• The build matrix is `fail-fast: false`.<br>• `rollout-api` and `rollout-meetings` wait only on the services they call.<br>• A preflight compares `env-spec` with `gcloud run services describe`.<br>• A failed deploy opens a `deploy-failed` issue. | L1, loopholes 2–3 |
| **H1b** `chore(scripts)` | `train.sh`: merge → deploy run → image SHAs → smoke; non-zero on red | Loophole 1 |
| **You** | 1. **Apply B.** I re-plan it at the head, you apply it, and I redeploy every service (a saved plan resets the images).<br>2. `E2E_INVITE_CODE`.<br>3. `VERCEL_AUTOMATION_BYPASS_SECRET`. | Loophole 4 |
| **Spike S1** (me, 1 day on staging, nothing merged) | 1. Which speech-to-text recognizers and models serve in `australia-southeast1`, and which diarize.<br>2. Which Gemini models serve in Sydney, as a second rung after 10-20.<br>3. gemini-3.5-flash's thinking parameter and output cap.<br>The results go in DECISIONS. | Unblocks H8, H10, H24 |

**Evidence:**
- a green deploy at the head, with the api's image at the head;
- smoke passing;
- one green nightly;
- one web-e2e run whose `e2e` job actually ran.

#### Stage 1: the quality sprint (10-02 → about 10-20), then cohort 1 (about 10-24)

**Before cohort 1, in this order:**

| H | PR | Closes | Fails first |
|---|---|---|---|
| H2 | `fix(db,transcoder)`: re-runs replace, and a duplicate can't double-pay.<br>• `markQueued` deletes the note's `transcript_lines` in its transaction.<br>• A per-note transcoder lease (the `034_job_leases` pattern).<br>• The op id saved before `startLongRunning`.<br>• Refuse a zero-length claim.<br>• Cap notes in flight per user.<br>• Bound yt-dlp.<br>• A never-kicked-off detector: an `upload_sessions` row completed with no `notes` row after 30 min is re-driven or reported. | L2 (server), L3, L6, L7 | Run, Try again: the line count is one run's. Two concurrent kickoffs give one speech-to-text op per chunk. |
| H3 | `fix(ios)`: a note is never stuck.<br>• Keep the file until the kickoff is accepted, and re-send on launch.<br>• Try again on a slow note.<br>• A background task with an expiration handler on both paths.<br>• The completion handler after complete and kickoff; wait for auth.<br>• One in-flight upload per note, with many waiters.<br>• Ask for the status on a 308.<br>• `UploadStallPolicy` wired in, and "Waiting for Wi-Fi".<br>• Import sidecars.<br>• **The upload loop's first tests.** | L2, L10, L11 | A stubbed URLProtocol: a 308 on the final chunk, two callers, a kill between upload and kickoff |
| H4 | `fix(ios)`: a meeting is one note | N1, LM2 | See LM2 |
| H5 | `fix(db,web,ios)`: 4 h passes | LM1, N3 | See LM1 |
| H6 | `feat(contracts,db,api,ios,web)`: **held for minutes.** A three-client contract change, additive.<br>• A new status, `awaiting_minutes`. The audio is kept while held, then follows retention.<br>• Nothing is charged.<br>• Resumed automatically on an invite redeem, a purchase, a grant, or the monthly reset (a db-job step).<br>• A warning before recording (minutes left) and during it (passing them).<br>• Notetaker notes keep "never refused". | LM6 (core) | Over quota → held → a grant → processed once; a replay is safe |
| H7 | `fix(infra,transcoder,db-job)`: the pipeline never drops work.<br>• Longer retry windows for transcode, embed and notify.<br>• Re-drive idle notes and stale polls.<br>• Transcoder timeout ≤ the 1800 s deadline, with the kickoff's wall time measured at 4 h.<br>• ffmpeg reads a signed URL instead of a `/tmp` copy (or memory sized from a 500 MB test).<br>• A Cloud SQL maintenance window.<br>• **Alerts:** sweep failure *and absence*, queue age, scheduler failures, Cloud SQL CPU and connections.<br>Then **Apply B′**. | L5, L6, P1 memory and alerts | tf-env-contract; a replayed poll; a 500 MB import on staging |
| H8 | `fix(ai,summarizer,api)`: Gemini ready for long meetings and 10-20 | LM4 | A salvage keeps chapters at 3 h; a real 3 h transcript in Sydney |
| H9 | `fix(api,contracts)`: chat and search caps. A three-client contract change (an additive `maxLength`).<br>• 2,000 characters and `maxOutputTokens`.<br>• A daily chat quota for guests and zero-minute accounts.<br>• Chat counted by `spend-guard.cjs`.<br>• Search returns only ready notes. | L4, P1 search | 2,001 characters → 400; an errored note's chunk is never returned |
| H10 | `fix(transcoder,embedder)`: Sydney speech-to-text and safe chunks.<br>• The regional recognizer from S1 as `STT_RECOGNIZER`.<br>• `wordsToLines` splits at about 30 s or 1,000 characters.<br>• The embedder splits an oversized chunk. | N2, P1 embedding | A 5,000-character line gives ≤ 2,000-character chunks; the staging log shows the `australia-southeast1` recognizer |
| H11 | `fix(ios)`: accounts and captures.<br>• Sign-out clears the App Group and consent.<br>• Every capture asks.<br>• A capture queue instead of delete-on-new.<br>• The extension writes ADTS (survives a kill), checks `writer.status`, has a 4 h cap and a disk check.<br>• A timer heartbeat.<br>• A guest's uploads survive an account switch. | L8, L9, N4, P1 accounts | XCTest per path |
| H12 | `test(e2e)`: long-meeting proofs, and the failure cases in R11.5 | LM3 | The e2e itself |
| H13 | `feat(ios)`: recording made easy | UX1–UX4 | XCUITest: 2 taps to record; no orphan file after a kill |
| H14 | `feat(web)`: the web made easy | UX6, LM8 | Vitest and a Playwright journey |
| H15 | `feat(ios)`: we see every failure. MetricKit (jetsam, hangs, background-task expiry) forwarded to Crashlytics; non-fatals with a hashed user id; the broadcast extension instrumented. | P1 iOS failures | A simulated MetricKit payload reaches Crashlytics on staging |

**Your steps for Wave 1, in order:**
1. Apply B.
2. The two secrets.
3. **This week: a real 45–60 minute meeting.** It's the 10-15 proof, and it counts only on gemini-3.5-flash.
4. The Vercel beta project and domain, the auth settings, and the VAPID key.
5. The restore drill (`docs/runbooks/restore-drill.md`).
6. P1 (I prepare it).
7. The Staging → Beta workflow, the external group, Test Information and the reviewer's code. **Submit for Beta
   App Review once H3, H4, H5, H11 and H13 are in a build** (about 10-20).
8. Proofs 1–11 (below), plus **a real 2-hour meeting** on iPhone and in Chrome.
9. **Legal, today:** the Terms, the Privacy Policy and `CONSENT.md`, including where speech-to-text runs (N2).

**Cohort 1 gate:**
- proofs 1–11 and the 2-hour meeting pass;
- the nightly is green 3 nights running, and a 120/240 run has passed once;
- staging deploys have been green for 3 days, and web-e2e has *run* green;
- H0–H15 are merged and running on staging, with evidence;
- no unexplained dead letters for 48 h;
- the `broadcast_capture` kill switch has been drilled;
- Beta App Review has approved.

**Proof changes:**
- Proof 6's "the level meter moves" holds in call mode, which proof 6 uses. H14 adds the meter to mic mode.
- Proof 11 (3 h locked, a call mid-way) now requires **one note**, with a **30-minute** call.

**During cohort 1, before widening:**

| H | PR | Closes |
|---|---|---|
| H16 | `feat(ios)`: Home and plain words | UX5, UX7 |
| H17 | `feat(ios)`: notes you can trust.<br>• The full-transcript export and the audio link refreshed (LM7 iOS).<br>• No signed URL in logs.<br>• Search as you type, and chat answers you can use.<br>• The paywall shows a rejection.<br>• Push at launch. | UX8, UX9, LM7, P1 |
| H18 | `feat(ios,web)`: minutes that never surprise | UX10, the rest of LM6 |
| H19 | `feat(ios)`: record a call, and accessibility | UX11, UX13 |
| H20 | `feat(api,web,ios)`: list and revoke share links, before `shareLinks` turns on | P1 security |

**Then the queued branches:**
- 24, 25, 29 (with H20), 30a–d, 31 (the load test), 32, the rate-limit test fix, 40 and 39a;
- the extension stack last.

#### Stage 2: find loopholes with testers

- **A beta health dashboard** (Terraform) with every R11.3 measure:
  - the funnel: started, uploaded, kicked off, ready, held;
  - time to notes in 1 h, 2 h and 4 h buckets;
  - stuck and failed notes by reason;
  - interruption splits;
  - dead letters, spend, and crash-free users.
- **A daily digest email** (a db-job), and support messages carrying the version, build and last traceId.
- **Journeys:** XCUITest against a Debug-only fake backend (first run, record, Stop, the note, rename, delete), and
  Playwright on the beta host.
- **Chaos drill on staging:**
  - kill a transcoder mid-run;
  - restart Cloud SQL;
  - drop the network mid-upload on a 2 h file;
  - replay a kickoff;
  - flip each kill switch.

  Each must end with one ready note, nothing duplicated, and one speech-to-text op per chunk.
- **Test charters:**
  - interruptions: a 30-minute phone call, Siri, AirPods, another app;
  - lock and leave; force-quit at each stage; airplane mode; Wi-Fi-only; low disk;
  - 1, 2 and 3 h meetings;
  - accounts: a guest upgrading mid-upload; switching accounts; deleting;
  - over quota, then a code;
  - the sandbox: buy, restore, refund;
  - the 426 gate;
  - Chrome: closing and reloading the tab, the laptop lid closed, the plan fetch offline.
- **Matrix:** iOS 17, a current iPhone and an SE at large text; Chrome and Edge; one low-memory Chromebook.
- **Triage:** every 48 h into `beta` issues, P0–P3. Every P0/P1 gets a regression test. A bad build is expired;
  switches are kill switches only.
- **Widening gate:** the R11.3 bar met for 7 days, with no P0/P1.

#### Stage 3: Wave 2 (the notetaker and Pro), and the P1 hardening

- **H21** `fix(billing)`: Stripe you can trust.
  - cancel a duplicate subscription;
  - an idempotency key per user;
  - a partial refund keeps Pro;
  - events ordered by fetching the subscription;
  - both payload shapes read;
  - secrets as Terraform references.
- **H22** `fix(infra)`: least privilege.
  - secret access per secret;
  - the extractor removed;
  - paging through the Google Cloud app.
- **H23** `fix(infra)`: sized for 100 testers.
  - api min 1 / max 3;
  - a separate poll queue;
  - db-g1-small;
  - a pool acquire timeout;
  - a per-user daily minute cap.

  The load test (31) passes after it.
- **H24** `feat(transcoder)`: speaker labels on long recordings (from S1, or AssemblyAI if you choose it).
- **H25** `feat(transcoder,web)`: a seekable AAC rendition of web recordings. Then 33b, with your go-ahead.
- **H26** `feat(ios)`: the note screen (UX12).

**Your steps for Wave 2:**
- Recall: the accounts, the DPA and the spike;
- Apple: the Paid Apps agreement, products, keys and sandbox testers;
- Stripe: test keys, and the webhook pinned to 2024-06-20;
- `FREE_FLOOR_MINUTES` from the measured cost;
- P2;
- the legal opinion before bots join meetings outside the allowlist.

**Proofs:** the Wave 2 list below, plus:
- a double checkout ends with one subscription;
- a renewal is recorded (Stripe test clock);
- a 2-hour notetaker meeting has real speaker names.

#### Stage 4: Wave 3 (the extension)

As in the Wave 3 section below, plus:
- the 4 h cap, and a local copy while uploading;
- 33b only with your go-ahead;
- a 2-hour Meet recorded from the extension.

#### Stage 5: the wow features, production, and 1.0

1. **The wow features** (decision 3), tested on devices through the cohorts.
2. **Production** as in the Prod-ready section below. Before prod, also:
   - CORS per environment;
   - Cloud SQL REGIONAL;
   - Firestore protection and backups;
   - paging;
   - the caps (decision 9).

   Stripe and StoreKit go live only after legal sign-off and a measured cost per minute.
3. **The App Store blockers:**

| A | Issue | Guideline | Plan |
|---|---|---|---|
| A1 | The Release build has no API origins, and nothing checks it carries prod's Firebase plist | — | After Apply P: set the origins, and fail the build unless `PROJECT_ID` matches |
| A2 | Release `UPDATE_URL` is `itms-beta://`, so it opens TestFlight (`project.yml:72`) | — | `itms-apps://apps.apple.com/app/id6816333591` |
| A3 | "Enter an invite code" is unconditional in Release (`SettingsView.swift:230`), and running out of quota opens it (`BillingService.swift:121-127`) | 3.1.1 | Compile it out of Release; use App Store Offer Codes |
| A4 | Web Pro is honoured, but Release has no in-app purchase | 3.1.1 / 3.1.3(b) | Ship 1.0 with the paywall live |
| A5 | The App Privacy answers in `STORE-COMPLIANCE.md` and `DATA-RETENTION.md` contradict the manifest and the code | 5.1.2 | Rewrite both, and the published policy, from `PrivacyInfo.xcprivacy` |
| A6 | Broadcast sits behind a server switch that defaults to off, yet Control Center can start it | 2.3.1 | If proof 5 passes after H11: on for review and described in the notes, the switch a kill switch only. Otherwise removed from 1.0. |
| A7 | A reviewer's device may already have used its trial | 2.1 | A free floor for every new account, regardless of DeviceCheck |
| A8 | A failed Apple token revocation is ignored | 5.1.1(v) | Verify Apple's key in prod Firebase, and prove a deletion |

Plus:
- **Listing:** screenshots (6.9") and a preview; the listing text, keywords and URLs; the age rating, answered
  honestly about AI; the EULA link.
- **Build:** Mac availability off; `aps-environment` set to production.
- **Review and release:** review notes (consent, guest start, broadcast, AI); a phased release; the 426 floor tested;
  the candidate build at ≥ 99.5% crash-free for 7 days.

### R11.6a H6 in detail: held for minutes (design for the owner's review, 2026-10-01)

The decision stands: a recording over the minutes left is held, never refused. Working through the code, it's a
change to three flows that rely on today's 402, so it lands as four PRs, not one.

**What happens today:**
- **The kickoff** refuses with a 402 before anything is written (`kickoff.ts` quota check). The web keeps the
  recording in the browser and offers the invite code, then an upload later (`RecordPage` "still saved in this
  browser"). iOS turns it into the paywall or the invite prompt, and the audio stays in Cloud Storage.
- **The transcoder's settle** (`measured-length.ts` `over_quota`) is where a recording is truly lost: it
  already uploaded, is refused with a refund, and the note fails.

**The PRs:**
1. **H6a** `feat(contracts,db)`: a note status `awaiting_minutes`.
   - Postgres keeps the kickoff's inputs, with no debit.
   - The mirror shows it. Old clients read an unknown status as in progress: iOS `Note.swift:231` falls back
     to `.processing`, and the web's `statusOf` too.
   - The settle's `over_quota` holds instead of failing. The audio stays, and nothing is charged.
2. **H6b** `feat(db-job,api)`: a held note resumes, oldest first and while the minutes cover it, when minutes
   arrive: an invite redeemed (`/v1/beta/redeem`), a grant, a purchase (billing), or the month turning over
   (a sweep step). It's queued exactly as a kickoff would be: `queueNoteRun`, charged then.
3. **H6c** `feat(api,web,ios)`: the kickoff's 402 becomes a hold for an **uploaded** recording, answered 202
   `{ status: 'awaiting_minutes' }`, so no client marks it failed. The web's pre-upload check keeps the
   recording local, as today, and offers the code first.
4. **H6d** `feat(web,ios)`: "Waiting for minutes" on the note, with the invite code or Go Pro; minutes left on
   the record screen; a warning when a recording passes them.

**Rules:**
- A held note is never charged.
- Retention applies from when it's held.
- A deleted held note purges its audio as any other.
- Notetaker notes keep "never refused".

### R11.7 Risks

| Risk | Mitigation |
|---|---|
| S1 finds no in-region speech-to-text | Decision 4: keep `global` and disclose it, or wait; the Privacy Policy is updated before any external tester either way |
| Only one Gemini model after 10-20 | S1's second rung, or the risk recorded in DECISIONS, with the truncation and `gemini_transient` alerts watched |
| One PR at a time slips 10-24 | The gate holds and the date moves |
| Beta App Review questions broadcast | Honest notes; `broadcast_capture=off` for the version if rejected |
| Staging on real money after 11-14 | Budget alerts verified; H23's cost recorded in DECISIONS before it's applied |

### R11.8 Verification

| Level | What |
|---|---|
| **Per PR** | The definition of done (R11.5). Sub-agents: `dual-write-auditor` (db, api), `pii-scrub-compliance` (H8, H9, H10), `log-fields-auditor`, `silent-catch-detector`. |
| **Per merge** | `train.sh`: deploy green, image SHAs at the head, smoke passing |
| **Long meetings** | The H12 e2e (ADTS and WebM; 60 nightly, 120/240 weekly). Device runs: a 2 h meeting on iPhone and in Chrome, and a 3 h locked recording with a 30-minute call that ends as **one** note. Times recorded against R11.3. |
| **Ease of use** | XCUITest (2 taps), Playwright journeys, VoiceOver and axe, an SE at large text |
| **Per stage** | The gate's evidence in BLOCKERS §0: traceIds, query results, run ids |

### R11.9 Decisions (my recommendation first)

1. **Taken:** over-quota recordings are held (H6).
2. **Taken:** quality first; cohort 1 about 10-24.
3. Pause, minimise and "record a call" in the beta; Live Activity, bookmarks and the follow-up before 1.0. **Yes.**
   This reverses rev 8, and the "Not in this plan" list below.
4. If S1 finds no in-region speech-to-text: keep `global` and disclose it in the Privacy Policy, or wait. **Decide
   after S1.**
5. Speaker labels: S1 first; AssemblyAI (US processing) only if it fails.
6. Invite minutes: **1,500 a month** (Pro's monthly minutes, the code's default) with the 4 h cap. The daily cap,
   and H23's per-user daily cap, hold the cost. The runbook's "600" was wrong and is corrected.
7. Money in 1.0: in-app purchase live, invite codes out of Release, web Pro honoured. **Yes.**
8. Broadcast in 1.0: decided by proof 5, after H11.
9. Staging for 100 testers: db-g1-small and api min 1 before cohort 2, about A$40–70 a month more (an estimate).
   Prod caps: A$60 a day, and a A$500-a-month budget alert.
10. Paging: the Google Cloud app on your phone for P0 alerts.


---

# Rev 10 (2026-09-29): the waves in detail

## Context

You asked for a look back at what's done, where we stand, and a plan that gets testers a robust TestFlight and
Chrome experience, with every feature working and us close to release. Your decisions today:

| Question | Decision |
|---|---|
| Audience | External testers as soon as possible (email-invited cohorts, growing) |
| Backend for the beta | **Staging now, prod later.** Testers start fresh on prod and are told so up front. |
| Minutes for testers | Invite codes in the app. **Test purchases too** (sandbox StoreKit, Stripe test mode; nobody is charged). |
| Web calls in Chrome | **All three:** the web app records the Meet tab, a notetaker bot joins the Meet, and a Chrome extension |
| Legal | Launch on the published drafts; send them for legal review now, in parallel |
| How far | A great beta, then production built and proven, so App Store 1.0 is one submission away |

It supersedes plan rev 9 (2026-09-26: internal TestFlight on staging, then external on prod), whose working copy
was a local file that has since been overwritten. `docs/plans/MEETINGS.md` stays the design for the notetaker and
the extension; this plan sets their order. BLOCKERS keeps the evidence for each step.

## Where we stand (verified read-only on 2026-09-29)

| Area | State |
|---|---|
| **iOS** | Build 1.0.0 (7) is installed on your iPhone. Built:<br>• guest start, Apple and Google sign-in, and upgrading a guest;<br>• a 4 h crash-safe recorder and background upload;<br>• summary, chapters, transcript, chat and search;<br>• deleting a note, and deleting an account with Apple revocation;<br>• push, and broadcast capture behind `/v1/config`.<br>The paywall is off and YouTube is removed. Not proven on a device: push, broadcast, Apple revocation, lock-after-stop and force-quit recovery. Not built:<br>• onboarding: a mic explainer, Open Settings on denial, a sample note;<br>• a Release logger; the admin card still ships (`SettingsView.swift:13`);<br>• a speaker rename chip;<br>• any notetaker UI. |
| **Web** | Built (W1–W11 merged): all `/v1`, guest/Apple/Google, notes, detail, rename speakers, edit, export, delete, import, mic recording, **Chrome tab capture** (#206), search, chat, settings, push (needs the VAPID key). But:<br>• **testers can't reach it**: staging `/app` is behind Vercel Authentication, and prod `/app` is "coming soon";<br>• call capture holds the whole file until Stop (no progressive upload), has no level meter and no upload guard;<br>• an unsent recording shows only on `/record`;<br>• `web-e2e` has never run for real (it needs the bypass secret). |
| **Notetaker (Recall, Meet)** | Server half built: #240–#247 (contract, data, KMS, create/cancel/follow a bot, allowlisted api). **Not applied, not deployed** (`deploy-staging.yml` omits meetings). Still to build:<br>• PR 10 ingest, PR 11 speaker hook, PR 12 reconcile and deletion;<br>• clients tolerating the new note, the web page and the iOS sheet.<br>#249 (disclosure) merged on 2026-09-28. The `/notetaker` page must be on **prod** (a promotion) before any bot joins. |
| **Chrome extension** | Nothing in the repo. Needs progressive upload (R3), a sign-in handoff, `POST /v1/notes`, and the MV3 extension itself. |
| **Billing** | Apple JWS verification and the v2 notification handler are coded. Missing:<br>• App Store Server API lookup and the reconcile job;<br>• StoreKit products, the `.storekit` file and a sandbox proof;<br>• a pre-purchase check;<br>• billing CORS, and the web's Stripe checkout UI;<br>• `FREE_FLOOR_MINUTES` (still null). |
| **Robustness (rev 9 Stage 2)** | Mostly not started:<br>• notifier permanent-error handling (S2-PR1);<br>• pipeline e2e (S2-PR2) and alerts (S2-PR3);<br>• metering exactness (S2-PR6c; `assertCanMeter` runs outside the queue transaction, `kickoff.ts:200`);<br>• sweep re-drive (S2-PR6b);<br>• dead-letter dedupe (S2-PR6a);<br>• a load test. |
| **Staging** | Healthy, but **deploys have been stuck since 2026-09-28 08:23 UTC.** Run 36397066772 waits at `migrate` and holds the concurrency group, so #236–#248 never deployed. `reviewed-7fd70b6.tfplan` is stale because #243 and #245 changed Terraform after it. Not ready for real users' data:<br>• no PITR and no deletion protection;<br>• a A$20/day cap (about 660 min);<br>• the trial can be reset by reinstalling, because the DeviceCheck token is hashed and never checked. |
| **Prod** | Only the site (promotion #198). `main` is 51 commits behind `integration`. Not built:<br>• prod Terraform and prod Firebase;<br>• `deploy-production.yml`;<br>• the Release API origins (`project.yml:61`, `TODO(prod)`). |
| **Legal** | Terms and Privacy are live and marked "pending legal review". No recording-consent opinion has been commissioned (NSW is all-party). |

Out-of-date BLOCKERS entries get fixed in PR 1: 55–58, 139–142, 213–217, 248–252, 579/630 (R2), 1208, 1378, 1444, and
1479/1484/1529.

## The shape: three beta waves, then prod-ready

| Wave | Testers get | Target (depends on the gates) |
|---|---|---|
| **1: record anything** | iPhone (external TestFlight) and **Chrome** (`beta.algominutes.algorythmos.com`): mic recording, Meet-tab capture, import, every note feature, search, chat, push, deletion. Minutes come from invite codes. | Cohort 1 (10–25) about 2026-10-10 to 10-13 |
| **2: the notetaker and Pro** | Paste a Meet link and the "AlgoMinutes Notetaker" joins, leaving a note with speaker names (iOS and web). The paywall is on with sandbox StoreKit and Stripe test mode. The trial is back on with real DeviceCheck. Share links and the speaker rename chip. | Up to 50 testers, about 2026-10-22 to 10-29 (needs your Recall accounts and Apple products) |
| **3: one click in Meet** | The Chrome/Edge extension: record the Meet tab, or send the notetaker, from a button in Meet. Unlisted in the Chrome Web Store, hidden in Edge Add-ons. Progressive upload everywhere. | Up to 100 testers, about mid-November (plus store review) |
| **Prod-ready** | The same product on prod: applied, deployed from `main`, and proven. The beta moves over with notice. App Store 1.0 is one submission away. | About late November (GCP credit ends 2026-11-14) |

**How work flows.**
- **The PR train:** one PR open at a time (your rule), CI green through the merge queue. Each PR runs the CLAUDE.md
  sub-agents, adds mutation-checked tests, and carries evidence in its description. No Claude attribution.
- **Order:** each wave's PRs go in the order listed. Notetaker PRs are in Wave 2's list, not a separate lane, so
  nothing competes.
- **Terraform:** batched into four applies (A, B, C, P). Each is re-planned right before you get it, you apply
  it, and I redeploy `services=all` and check every image.
- **Promotions** to `main` (yours) happen at P1 (before Wave 1 opens), P2 (before any bot joins) and P3 (prod).

## Wave 0: unblock (today, me)

1. Cancel stuck run 36397066772 (**done 2026-09-29**; the run for 41ec920 took its place), which deploys
   #236–#249. The api reads its KMS key lazily (`routes/meetings.js:89`), so this is safe before the apply.
   - Evidence: `migrate` reaches 024, the smokes pass, and every image is the deployed commit.
   - If `migrate` waits again, the `staging` environment's settings are yours to look at.
2. **PR 1** `docs`: `docs/plans/RELEASE.md` (this plan), plus the BLOCKERS refresh. The refresh fixes the stale
   entries, adds the stuck deploy, and moves the rev 9 references here.
3. ~~Queue #249 (disclosure) into `integration`.~~ It merged through the queue on 2026-09-28 (41ec920).

## Wave 1: record anything (iPhone and Chrome)

### PRs (in order)

**Order change (2026-09-29):** PR 6 moved ahead of PR 5, and PR 5 moves after PR 11. Apply A is the owner's
longest wait on the path to testers, so its PR goes first. PR 5 (dead letters once, the sweep re-drives lost work)
is rare-path robustness, and was scoped as two PRs, 5a and 5b.

| # | PR | What it does | Done when |
|---|---|---|---|
| 2 | `feat(db,api,contracts)` invite codes | See "Invite codes" below | The integration tests below pass, mutation-checked |
| 3 | `fix(api,db)` the kickoff refuses correctly (rest of R2, S2-PR6c core) | • the quota check moves inside `markQueued`'s transaction<br>• a retry whose charge stands needs no headroom<br>• a server-side length cap for one note (the claimed length; 413)<br>• the spend cap checked at kickoff (503) | Two concurrent kickoffs can't overspend; tested on Postgres |
| 3b | `fix(transcoder,db)` the ledger follows the measured length | • imports (and every recording) metered on the transcoder's ffprobe duration, with the ledger corrected when it differs<br>• the length cap enforced on the measured duration | A 0-minute import is charged its real length; tested on Postgres |
| 4 | `fix(notifier,api)` S2-PR1 | • ack only permanent errors<br>• prune a token only on `not-registered`<br>• the 426 minimum comes from contracts | Tests per error class |
| 5 | `fix(workers,db-job)` S2-PR6a + 6b, **split: 5a one dead letter per note (Q2–Q4, Q7); 5b a kickoff carries its run, and Deepgram can't boot (Q12, Q30); 5c the sweep re-drives lost summaries and embeds (Q9–Q11; the sweep job already had its queue settings and enqueue role, so no Terraform)** | • one dead letter per note (Q2–Q4, Q7)<br>• the sweep re-drives lost work (Q9–Q12, Q30) | A killed task is re-driven once, with no duplicate rows |
| 6 | `feat(infra)` staging becomes the beta (**Apply A**) | • deletion protection and PITR (enabling PITR restarts Cloud SQL once)<br>• recordings kept (no 7-day lifecycle), buckets and Firestore not destroyed with the stack<br>• `trial_on_first_use=false`<br>• an explicit `DAILY_SPEND_CAP_AUD`: yours, I suggest A$50<br>• `monthly_budget`: yours, I suggest 250<br>• `ALLOWED_ORIGINS` gains the beta web origin<br>• `TF_VAR_admin_uids` with your uid<br>• also carries #236, #238, #243, #245 | `gcloud sql instances describe` shows PITR and protection on; preflight from the beta origin answers 204 |
| 7 | `feat(site,web)` the beta host | • `vercel.json` gets a `/__/auth` rewrite and a CSP for `beta.algominutes.algorythmos.com`<br>• the build script accepts the beta project<br>• sign-in on the domain's own `/__/auth`, like prod will | `site-build` builds the beta shape; `check-signin-chain.mjs --env beta` passes |
| 8 | `feat(ios)` minutes in the beta | • a Settings **Invite code** row<br>• with the paywall off, a quota hit opens the code sheet (not a silent no-op, `BillingService.swift:111`)<br>• the record screen says up front when there are no minutes<br>• a refused note offers **Try again** after redeeming<br>• What to Test updated | XCTest for each |
| 9 | `feat(web)` minutes in the beta | The same, in web Settings and on a 402 | vitest |
| 10 | `feat(ios)` first run and error states (S2-PR4 core), **split into 10a (permissions), 10b (the example note) and 10c (recovery: the reconnecting banner, Retry)** | • a mic explainer, then **Open Settings** on denial<br>• a notification pre-prompt<br>• a bundled **sample note**<br>• a "reconnecting" banner (`listenerHealthy` is set but never read)<br>• Retry on chat and search<br>• Dynamic Type on the chips | XCTest and XCUITest for the explainer and the sample note |
| 11 | `chore(ios)` Release hygiene (S2-PR5) | • `AppLog` becomes `os.Logger` with Crashlytics breadcrumbs<br>• the admin UI is compiled out of Staging and Release<br>• the mic usage text covers capturing another app's call<br>• the "can be reset" copy becomes the beta's promise | A grep test; the Staging build has no admin symbols |
| 12 | `fix(web)` a Chrome tester never loses a recording, **split into 12a (web only: the first four) and 12b (retention from the account, a contract change for all three clients)** | • unsent recordings show on Notes<br>• the upload is guarded (`beforeunload` during upload)<br>• a re-upload reuses its note, not a second one<br>• sign-out warns, then clears local recordings (BL:1463)<br>• retention is read from the account (BL:1466) | vitest, plus the Playwright crash-and-reload case |
| 13 | `feat(web)` Meet-tab capture you can trust | • a live level meter and a "this tab is silent" warning (the `Waveform` exists)<br>• the tab's video constrained to 1 fps at minimal size<br>• `AudioContext` resume on suspend<br>• a mic mute toggle<br>• a hint that desktop Zoom/Teams on Mac need iOS or the notetaker | vitest; a Playwright test with Chrome's fake tab and mic flags records a tone into a note |
| 14 | `ci(e2e)` S2-PR2, **split: 14 the pipeline e2e (an anonymous user with an e2e invite code, not a custom token), 14b `web-e2e` on the beta host with the invite code, once the beta host is up** | • `e2e.yml`: a custom-token user; 2- and 15-minute fixtures nightly and 180 minutes weekly<br>• checks Postgres, Firestore, one traceId and no dead letters<br>• `web-e2e` turned on, with the call-capture case | First green nightly on staging |
| 15 | `feat(infra)` alerts (S2-PR3) | • SLO-4 time-to-summary<br>• billing uptime<br>• support requests<br>• exhausted tasks<br>• Q29: stop logging Vertex error bodies | Each alert fired once on staging, with the evidence |
| 16 | `docs(runbooks)` the beta pack | • `testflight-external.md`: beta description, review notes (consent, broadcast, invite codes, staging backend), the reviewer's code, cohorts, expiring a build<br>• `web-beta.md`: a Chrome tester guide (share the tab and tick "Also share tab audio")<br>• the restore drill steps | Reviewed by you |

### Invite codes (PR 2) in detail

- **Migration 025**, expand-only:
  - `beta_invites`: `code_hash` unique (SHA-256 of the normalised code), label, `included_minutes`, `grant_days`,
    `max_redemptions`, `redemptions`, `notetaker` (bool, used in Wave 2), `expires_at`, `revoked_at`.
  - `beta_invite_redemptions`: (invite_id, uid) primary key, with uid cascading on delete.
- **`packages/db/src/beta-invites-repo.ts`:** `redeemInvite(uid, code)` in one transaction.
  - It locks the invite row with `FOR UPDATE`, so uses can't overrun.
  - A replay by the same uid is idempotent.
  - It upserts `entitlement_grants` (019, one row per uid) with reason `invite:<id>`. It never shortens or
    reduces a grant already there (`GREATEST` on the expiry, where NULL means until revoked).
  - When `notetaker` is set, it also allowlists the uid in `notetaker_testers` (024).
- **`POST /v1/beta/redeem`:**
  - 200 returns an `EntitlementResponse`; errors are 4xx `invalid`, `expired` and `used_up`.
  - A per-uid limit of 10 an hour (`packages/ai/src/rate-limit.cjs`), on top of the IP limit.
  - Guests may redeem.
  - The code is never logged; `inviteId` is logged instead, and a test proves it.
- **Contract:** additive in `openapi.v1.json` plus the generated models, with the route ratchet updated.
- **Trial switch:** the `TRIAL_ON_FIRST_USE` env, default on. When it's off, `ensureTrial` opens a new user on the
  free floor.
- **db-job `create-invite` / `revoke-invite`:** you pass a code from `scripts/new-invite-code.sh`
  (`BETA-XXXXX-XXXXX-XXXXX`, 75 bits). Only its hash is stored.
- **Tests (Postgres):**
  - replay, expired, revoked, used up;
  - concurrent last use (exactly one wins);
  - a grant already there isn't reduced;
  - account deletion cascades;
  - the rate limit;
  - refused note → redeem → retry → queued;
  - two users can't see each other's rows.

### Your steps for Wave 1

1. Apply A (after PR 6). Choose the daily cap and budget figures.
2. **Vercel:** a second project, `algominutes-beta`.
   - Its production branch is `integration`, with the domain `beta.algominutes.algorythmos.com`.
   - Its env vars are staging's.
   - A production domain is public, so previews stay protected.
   - Then a Cloudflare CNAME, Firebase authorized domains, and the Apple Services ID return URL plus the Google
     OAuth origin and redirect for the beta domain.
   - Also the `VITE_FIREBASE_VAPID_KEY` (web push) and the `VERCEL_AUTOMATION_BYPASS_SECRET` (e2e).
   - *Fallback if you'd rather:* switch Vercel Authentication off for `algominutes-site`, which makes every preview
     public.
3. **Zoho:** aliases `support@` and `privacy@algorythmos.com` receive mail. Turn on auto-renew for
   `algorythmos.com` (expires 2026-12-06).
4. **Restore drill:** restore the staging PITR backup to a clone, count notes, delete the clone.
5. **Promotion P1:** `integration` → `main`, so the live privacy page, terms and #249 match what the beta does.
   I check the diff and hand you the PR.
6. **Xcode Cloud:** a **Staging → Beta** workflow.
   - It archives `AlgoMinutes-Staging` with distribution **TestFlight and App Store**; the internal-only
     workflow's builds can never go external.
   - Its post-action is internal only. You add a build to the external group by hand after the every-build
     checklist.
7. **TestFlight:** an external group, "AlgoMinutes beta" (email invites). Fill in Test Information from the
   runbook. Create the reviewer's code (5 uses, 30 days). Submit.
8. **Legal:** send the Terms, Privacy Policy and `docs/CONSENT.md` to a lawyer now. Include the recording
   consent (NSW all-party), bots in meetings, and APP 8 cross-border.

### Wave 1 proof (you on iPhone and Chrome; I check each in logs and Postgres, and record traceIds in BLOCKERS)

| # | Check |
|---|---|
| 1 | Fresh install as a guest: refused with the code prompt → redeem → Try again → note |
| 2 | 15 minutes, lock right after Stop: the note finishes, the push arrives, and a tap opens it |
| 3 | **A real 45–60 minute meeting:** `gemini_ok` `finishReason: STOP`, chapters present, nothing truncated. This is the gemini-2.5-flash retirement check, **due 2026-10-15** |
| 4 | Search finds a word, and chat answers with a source (iOS and web) |
| 5 | **iOS broadcast:** a FaceTime or Zoom call with both sides in the transcript. If it fails, `broadcast_capture=off` for this version. It must not be switched on after review (Guideline 2.3.1) |
| 6 | **Chrome:** a 30-minute Google Meet recorded from the Meet tab plus the mic. Both sides are in the transcript, the level meter moves, and closing the Meet tab saves it |
| 7 | Chrome: reload mid-recording, and it's recovered and uploaded once |
| 8 | Delete a note: it's gone from search, and Postgres has `deleted_at` |
| 9 | An Apple-linked test account deletes itself: it's gone from Settings → Apple ID, and Postgres has no rows (iOS). The web deletion path is also exercised |
| 10 | Force-quit mid-upload, then relaunch: it resumes and finishes |
| 11 | A 3-hour locked-screen recording with a call mid-way (can run overnight) |

**Gate to invite cohort 1:**
- all 11 checks pass;
- the nightly e2e is green 3 nights running;
- no P0/P1 is open, and no unexplained dead letters for 48 h;
- Beta App Review has approved the build.

## Wave 2: the notetaker and Pro

### PRs (in order)

| # | PR | What it does |
|---|---|---|
| 17 | `feat(infra)` notetaker and billing on staging (**Apply B**), **the parts usable now: meetings' Storage role on the recordings bucket, and billing CORS from the one shared allowlist. The App Store Server API and DeviceCheck key secrets land with PRs 26 and 22, which read them; `notetaker_surfaces=bot` and `trial_on_first_use=true` are plan-time values** | • `notetaker_surfaces=bot`<br>• a Storage role for `run-meetings`, scoped to the recordings bucket<br>• Recall and App Store Server API secrets wired (empty; you add the versions)<br>• DeviceCheck key secret<br>• `trial_on_first_use=true` (after PR 22)<br>• billing CORS from `ALLOWED_ORIGINS` |
| 18 | `ci(deploy)` meetings in `deploy-staging` | The filter, `all`, and a health smoke. Can merge before Apply B: the service reads its Recall secrets per request (503 without them), and Apply A already made its IAM, KMS key and secrets; only PR 19's ingest needs Apply B's Storage role |
| 19 | `feat(meetings)` PR 10 ingest | • wait for both `audio_mixed.done` and `participant_events.done`, then one `ingest` task per bot<br>• SSRF-safe download (HTTPS, Recall and S3 hosts only, same-host redirects, size caps), streamed to `recordings/{ws}/{noteId}.mp3`<br>• participants and segments stored, reserved minutes settled, then `queueNoteRun`, once per bot (`meeting_bots.run_queued_at`, stamped under the note's lock, so a replay never runs a meeting twice); the bot then ends (`done`)<br>• a note deleted before or during ingest takes Recall's copy and every version of the audio with it; on the last attempt, a recording that never became ours fails its note<br>• `delete_media` asked for at once, and a purge worker every 30 minutes (Cloud Scheduler) until each is confirmed; `recall_purge_exhausted` alerts<br>• Its Terraform (`GCS_BUCKET`, the schedule, two alerts) rides in Apply B with PR 17's Storage role |
| 20 | `feat(transcoder)` PR 11 speaker names | • `alignWords` hooked into the Google STT poll (per word, at its place in the whole recording) and the whole-file provider paths (per line)<br>• a notetaker note takes the chunked path whatever its length, read from `source_kind` in Postgres<br>• `note_speakers` seeded once at ingest (PR 19), so a rename wins |
| 21 | `fix(meetings,db)` PR 12 | • a reconcile every 15 minutes: webhooks never processed, bots never sent, recordings whose ingest never ran (Recall asked; media never arrived fails at 6 hours), bots silent for 3 hours (Recall asked how they ended)<br>• `deleteNote` and account deletion queue Recall's purge in their own transaction (a bot still in the meeting leaves), and the api starts the purge worker at once<br>• last attempts of `create_bot`, `cancel_bot`, `process_event` and `ingest` write a Postgres dead letter (queue `meetings`); a poison event is closed so it isn't re-driven for ever |
| 22 | `feat(api,ios)` real DeviceCheck (S3-PR3) | Apple's two-bit API (`packages/ai/src/devicecheck.cjs`): the api asks whether a new iOS user's device has had a trial (bit0) and sets it once one starts; Apple unreachable fails the kickoff for a retry rather than deny the trial; a refusal for good (our key, a bad token) is no trial and alerts. The hash seam is retired, and the platform comes from the client-version gate (an unknown one gets no trial). The key is the `devicecheck-key` secret (the owner's), read at run time; prod's trial stays off until it's set |
| 23 | `feat(web,ios)` PR 3 clients understand notetaker notes | • a notetaker's note says what its notetaker is doing (on its way, joining, waiting to be let in, in the meeting, recording, getting the recording), in the list and on the note; a status a build doesn't know reads as in progress<br>• cancel it before it records, or stop it while it does (what it recorded is kept), after a confirmation<br>• a failed one shows its reason, with no minutes used |
| 24 | `feat(web)` PR 13 send a notetaker | Paste a Meet link, the CONSENT §2.4 tick box (the create contract has no field for it, so the UI enforces it, with a test), a status chip, cancel |
| 25 | `feat(ios)` send a notetaker, and rename speakers | The same sheet, plus the tap-to-rename speaker chip (BL:134) |
| 26 | `feat(billing)` purchases you can trust (S3-PR10), in three | **26a:** the App Store Server API client (`services/billing/src/lib/app-store-server.js`; Apple's answer verified to Apple's root like a notification), and an hourly reconcile (`/tasks/reconcile-apple`, Cloud Scheduler with an OIDC token checked by the shared `@algominutes/ai/task-auth.cjs`) that corrects a subscription whose notification never arrived without undoing a newer one (BL:205). Sandbox purchases entitle in **every** environment, as `docs/DECISIONS.md` ("Real IAP in sandbox") requires for TestFlight and App Review; each is logged with its environment. The key is the `app-store-server-key` secret, with `app_store_issuer_id` and `app_store_key_id`.<br>**26b:** a pre-purchase entitlement check (BL:209) and `EntitlementResponse.source` (S2-PR6e / BL:158), so a grant isn't counted as a purchase.<br>**26c:** deploy workers before the api (Q25) |
| 27 | `feat(ios)` the paywall in the beta | • `PAYWALL_ENABLED` on in Staging<br>• a `.storekit` config for tests<br>• purchase, restore and renewal in XCTest (StoreKitTest)<br>• the grant and invite paths kept |
| 28 | `feat(web)` Stripe checkout (test mode) | The `/billing/*` handoff, checkout, the portal and success/cancel states; a Playwright test with test card 4242 |
| 29 | `feat(contracts,api,clients)` share links | A `/v1/config.shareLinks` switch, turned on in iOS and web. The viewer at `/app/s/:token` on the beta domain |
| 30 | `fix(db,sync)` S2-PR6d: the two stores converge (Q20–Q23) | Plus S2-PR9: the contract's JSON fixtures decoded in iOS tests |
| 31 | `test(load)` `scripts/load-staging.mjs` | 50 concurrent 15-minute uploads and 10 bots. The queue caps hold, and Cloud SQL CPU stays under 70% |

### Your steps for Wave 2 (start the long ones now)

- **Recall:**
  - start now: two accounts in Tokyo (staging, prod), the startup-rate application, and the DPA with a
    no-training confirmation;
  - then add the API key and webhook secret versions in Secret Manager, and point the webhook at
    `https://<meetings url>/webhooks/recall`;
  - with me: run the 7-check spike.
- **Apple:**
  - start now: the Paid Apps agreement and the Small Business Program;
  - create the subscription group and Pro monthly and yearly products;
  - an App Store Server API key and a DeviceCheck-enabled key into Secret Manager;
  - sandbox tester accounts.
- **Stripe:** test-mode secret, webhook secret and price ids into staging's Secret Manager.
- **FREE_FLOOR_MINUTES (D2):** I measure the blended cost per minute from Wave 1's `usage_events`. You pick the
  floor; 120 minutes is the earlier recommendation.
- **Apply B**, then **promotion P2**, so `/notetaker` is live before any bot joins.
- Invites for Wave 2 carry `notetaker: true`.

### Wave 2 proof

1. A Meet with 3 people: the bot joins as "{name}'s notetaker (AlgoMinutes)" and pins the notice linking the live
   `/notetaker` page. The note has real speaker names, and a rename sticks.
2. Cancel a bot before it's admitted, and when it's refused: a clean failure reason, and minutes refunded.
3. Delete a notetaker note: the bot leaves, and the Recall media purge is confirmed.
4. **iOS sandbox:** buy Pro, restore on a second device, let it renew and expire. The entitlement follows each
   step, including after a missed notification (the reconcile job).
5. **Web:** Stripe test checkout, the portal and cancel.
6. A reinstall doesn't get a second trial (DeviceCheck).
7. A share link opens in a signed-out browser, and revoking it ends access.
8. The load test report is in BLOCKERS.

## Wave 3: one click in Meet (the Chrome/Edge extension)

| # | PR | What it does |
|---|---|---|
| 32 | `docs` ADR 0002 | The extension's design, permissions and data flow (`docs/decisions/` is created) |
| 33 | `feat(contracts,api,web)` R3 progressive upload | `totalBytes` optional (unknown-length resumable). The web recorder uploads while recording, so the upload is done within 10 s of Stop |
| 34 | `feat(api)` the extension's sign-in | `POST /v1/auth/extension-link`: a one-time code, 60 s, bound to the uid, the extension id and a verifier. It's exchanged for a Firebase custom token |
| 35 | `feat(api,db)` `POST /v1/notes` | Reuses `createServerNote`, so the extension creates its note server-side |
| 36 | `feat(infra,api)` extension guards (**Apply C**) | `extension` in `MIN_SUPPORTED_CLIENTS`, the extension origins in `ALLOWED_ORIGINS`, and `extension` in `NOTETAKER_BUILT` |
| 37 | `feat(extension)` `apps/extension` (MV3, Chrome and Edge) | • `tabCapture` in an offscreen document, with the mic and the tab on separate channels<br>• a popup, and a button on meet.google.com (record, or send the notetaker)<br>• the consent tick; progressive upload; status<br>• `externally_connectable` with a `sender.origin` check; `chrome.storage.session`<br>• CI: build, lint, unit tests, and Playwright with the extension loaded and fake media |
| 38 | `docs(runbooks)` the extension beta | The store listing text, permission justifications, the privacy-practices answers, and the tester guide |

**Your steps:**
- Chrome Web Store and Edge Add-ons developer accounts (**start now**).
- Submit it unlisted in the Chrome Web Store and hidden in Edge Add-ons. Review takes days to weeks, and longer
  for `tabCapture`.
- Apply C.

**Proof:**
- a 60-minute Meet recorded from the extension, uploaded progressively;
- the notetaker sent from the extension;
- an uninstall or browser restart mid-capture is recovered or reported;
- signing out of the web signs the extension out.

## Prod-ready (so App Store 1.0 is one submission away)

| # | PR / step | What it does |
|---|---|---|
| 39 | `feat(infra,ci)` S3-PR4 | • the prod root finished, and `deploy-production.yml` (runs from `main` after a promotion, with migrate, vertex-smoke, rollout and both smokes)<br>• the Release origins in `project.yml`<br>• the prod CSP and `/__/auth` in `vercel.json`<br>• PITR and deletion protection on |
| 40 | `fix(api,db)` S3-PR11 | • the api checks token revocation (`verifyIdToken(…, true)`, `middleware/auth.js:34`)<br>• shared workspaces on account deletion |
| — | **Yours: Apply P** | • bootstrap `algominutes-prod-tfstate`, then apply<br>• prod Firebase: Blaze, providers, APNs key, iOS/web apps, VAPID<br>• a prod Apple Services ID return URL<br>• a prod Recall account<br>• Vercel Production env plus `APP_ENABLED`<br>• re-scope the prod budget |
| — | **Yours: promotion P3** | Then the first prod deploy, the authenticated smoke, and a prod restore drill |
| 41 | `build(ios)` Release → External | A new Xcode Cloud workflow on `main` (scheme `AlgoMinutes`, the prod plist). `UPDATE_URL` stays `itms-beta` until 1.0 |
| — | **Beta moves to prod** | • A final staging build tells testers that the next build is the public service and beta notes stay behind, with export shown. Then the first prod build goes to the same external group.<br>• Invites and the trial work on prod, with DeviceCheck enforced.<br>• Stripe stays in test mode until 1.0. |
| — | **Decisions for 1.0 (yours)** | • STT residency (S3-PR2: global vs a region)<br>• live Stripe and live StoreKit prices from measured COGS<br>• the palette and typeface<br>• age rating |

**The App Store 1.0 list** (the next plan executes it; recorded here so nothing is lost):
- screenshots and a preview video;
- the App Privacy answers (fix `STORE-COMPLIANCE.md` §2, which is stale against `PrivacyInfo.xcprivacy`);
- the store listing text, and `UPDATE_URL` → `itms-apps`;
- legal sign-off.

## Always on: the quality program (runs through every wave)

- **Automated:**
  - the nightly and weekly pipeline e2e (PR 14);
  - the web Playwright suite, including call capture, after every staging deploy;
  - the extension Playwright suite (Wave 3).
- **Before each wave:**
  - a device matrix (an older iPhone on iOS 17, a current one on iOS 26);
  - a browser matrix (Chrome, Edge; Safari and Firefox mic-only);
  - a 1-hour bug bash;
  - `/security-review` of anything new (web, meetings, extension);
  - an axe pass on the web and a VoiceOver pass on iOS.
- **Measured and reported per wave** in BLOCKERS: the `PERFORMANCE-BUDGET.md` pipeline numbers (p50/p95 from
  logs), crash-free rate, dead letters, the SLO table, and cost per minute.
- **Every P0/P1** ships with a regression test.

## Running the beta

- **Cohorts:**
  - Wave 1: 10–25 people;
  - Wave 2: up to 50;
  - Wave 3: up to 100.
  - Each invite carries a code (minutes and days; `notetaker` from Wave 2).
- **Feedback:** TestFlight feedback plus the in-app support form on both clients. I triage every 48 h into GitHub
  issues labelled `beta`, P0–P3 (`testflight-internal.md`).
- **Pulling a bad build:** expire it in TestFlight. Server switches work without a build: `broadcastCapture`,
  `notetaker`, `shareLinks`.
- **Widening the beta:** 7 days with no P0/P1, crash-free at least 99.5%, spend under the cap, and the nightly e2e
  green.

## Cost and caps (estimates; measured numbers replace them after Wave 1)

- **Pipeline:** about A$0.03 per minute (`COGS_AUD_PER_MINUTE`). The notetaker adds Recall at US$0.0083 per minute
  (US$0.0042 at the startup rate).
- **Example:** 25 testers × 10 hours a month is about A$450 of pipeline, plus about US$125 if every minute is a
  bot.
- **Caps:** the staging daily cap (your figure), 1,500 minutes per invite per 30 days (Pro's monthly minutes, the code's
  default; rev 11 decision 6), and the notetaker defaults of
  600 minutes a month and 20 concurrent bots.
- **GCP credit** (~US$411) ends 2026-11-14.

## Everything only you can do (start the long ones today)

| When | Step |
|---|---|
| **Today** | • Legal review request<br>• Recall: 2 Tokyo accounts, startup rate, DPA<br>• Apple: Paid Apps agreement and Small Business Program<br>• Chrome Web Store and Edge developer accounts<br>• domain auto-renew and Zoho aliases |
| Wave 1 | • Apply A, cap and budget figures<br>• the Vercel beta project and domain, plus the auth settings<br>• VAPID key and bypass secret<br>• restore drill<br>• P1 promotion<br>• the Staging → Beta workflow, external group, Test Information and submission<br>• invite codes and cohort 1<br>• the Wave 1 proof on your iPhone and in Chrome |
| Wave 2 | • Recall secrets, webhook and spike<br>• StoreKit products, Server API key and DeviceCheck key<br>• sandbox testers<br>• Stripe test secrets<br>• Apply B and P2<br>• FREE_FLOOR decision |
| Wave 3 | • Apply C<br>• extension store submissions |
| Prod | • Apply P<br>• prod Firebase and Recall<br>• Vercel Production<br>• P3<br>• the Release → External workflow<br>• the 1.0 decisions |
| Hygiene | • Rotate the staging Browser key<br>• rotate the leaked Gemini key (source repo)<br>• `uuid` alert decision |

## Not in this plan (post-launch, on purpose)

Rev 11 decision 3 proposes moving pause into the beta, and Live Activity, bookmarks and the follow-up before 1.0.


- Android (v1.1; `apps/android` has only the ported audio layer) and iPad.
- Live Activity, pause and bookmarks, the follow-up sender.
- Calendar auto-join (M2: Google OAuth verification takes weeks, so start it only if you want it soon after
  launch), Zoom and Teams import (M4), the Mac app (M5).
- The AssemblyAI switch (D7), and localisation beyond English.
- The Node 26, Express 5, TypeScript 7 and google-auth-library 11 migrations, and iOS strict concurrency (S3-PR9).

## Verification (the whole)

**Every feature, proven on each surface:** an automated test, plus the wave's manual proof with a traceId in
BLOCKERS.

| Feature | iPhone | Chrome web | Extension |
|---|---|---|---|
| Guest start, and upgrading to Apple/Google while keeping notes | W1 | W1 | W3 (handoff) |
| Mic recording: 2 min, 60 min, 3 h locked | W1 | W1 (60 min) | n/a |
| Capture a call (broadcast, Meet tab) | W1 | W1 | W3 |
| Notetaker bot from a Meet link | W2 | W2 | W3 |
| Import an audio file | W1 | W1 | n/a |
| Summary, actions, decisions, chapters (seek), transcript, playback | W1 | W1 | n/a |
| Speaker names and rename | W2 | W1/W2 | n/a |
| Edit, regenerate, export, share link | W1/W2 | W1/W2 | n/a |
| Search and chat with sources | W1 | W1 | n/a |
| Push when ready, and tap opens the note | W1 | W1 (VAPID) | n/a |
| Delete a note, delete an account (Apple revocation) | W1 | W1 | n/a |
| Minutes: invite, trial (DeviceCheck), purchase, restore, quota messages | W1/W2 | W1/W2 | n/a |
| Interruptions (call, low disk, force-quit, tab close, network loss) | W1 | W1 | W3 |
| The "please update" gate (426) | W1 | W1 | W3 |
| Support and feedback | W1 | W1 | W3 |

**Per PR:**
- CI green (22 checks) through the merge queue;
- the dual-write, log-fields, silent-catch and pii-scrub sub-agents where they apply;
- a two-account tenancy test for any new query;
- a replay test for any new async handler;
- mutation checks.

## Risks

| Risk | Mitigation |
|---|---|
| Beta App Review questions broadcast or recording | Honest review notes and usage text, and the Wave 1 check 5 proof. If rejected, `broadcast_capture=off` for this version and a new build |
| Google Meet refuses or holds guest bots | The Wave 2 spike measures it. The fallback is a Workspace with SAML (yours, only if needed) |
| The extension's store review is slow | Submitted unlisted early in Wave 3. Tab capture on the web covers Chrome meanwhile |
| Spend | Daily cap with a clean refund at the cap; per-invite caps; the budget alerts; the measured cost per minute after Wave 1 |
| Real data on staging | Deletion protection, PITR and the restore drill come before any invite. The 30-day retention already applies |
| 2026-10-20 model retirement | Wave 1 check 3 proves gemini-3.5-flash on a long meeting by 2026-10-15 |
| Legal | Drafts are live and marked, the review is requested today, and the notetaker stays allowlisted (beta invites only) until the opinion arrives |
