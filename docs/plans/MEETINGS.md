# Online meetings: plan and design (2026-09-28)

> The approved plan (rev 2) for capturing online meetings. It was checked against `origin/integration` (13acfc2)
> line by line, and adversarially against Recall.ai's docs and CLAUDE.md. The decision and its reasoning are in
> `docs/DECISIONS.md` ("Online meetings are captured by a Recall.ai notetaker bot first"). Consent is in
> `docs/CONSENT.md` §2.4.
>
> **The owner's decisions:** a Recall.ai notetaker bot first; Google Meet first; surfaces are calendar + bot, a
> Chrome/Edge extension, cloud-recording import (Zoom first) and a Mac app; robustness hardening
> (`docs/BLOCKERS.md`) runs in parallel.
>
> **Hard prerequisites for M1 testers:**
> - gemini-2.5-flash has a proven replacement rung before its 2026-10-20 retirement;
> - the pipeline has hard timeouts, a server-side duration cap, and correct handling of `recording` notes.

## Design

**Principles:**
- **One pipeline.** Every source ends in GCS, then `queueNoteRun()`, then the transcoder.
- **One bot gives one note in one workspace.**
- **The bot is visible and announced.**
- **Auto-join is off by default.**
- **Recall's copy is deleted once ingested.**
- **A `/v1/config` kill switch per surface.** It is **off in every environment by default**, and a failed config fetch means off.

### Architecture

**`services/meetings` (new, public, like billing), the only code that talks to Recall.** It owns:
- Recall's bot and calendar webhooks;
- the calendar OAuth callback;
- the `/tasks/*` handlers: create, adopt, cancel, leave, ingest, purge, calendar sync and reconcile.

Its operating cost goes into DECISIONS: scale-to-zero, one `meetings` queue with Postgres dead letters and replay, a
dashboard, and the alerts under Operations.

The api hosts every `/v1` endpoint. It writes the intent rows and the note through the repo, enqueues a task, and
returns 202. **It never calls Recall inside a user request.**

**Security on a public service.** Services on the public list run with `invoker_iam_disabled` (`cloud-run.tf`),
so Cloud Run itself checks nothing.
- **`/tasks/*`:** the app verifies the Google OIDC token itself: exact audience, the jobs service account email, and `email_verified`. A test pins this.
- **Webhooks:**
  - Parse with `express.raw` before any JSON parsing.
  - Check **every** signature in `webhook-signature` against `{webhook-id}.{webhook-timestamp}.{body}`, with `timingSafeEqual` and a length check.
  - Allow a ±5 min timestamp window.
  - Accept **two** `whsec_` secrets during rotation.
  - De-duplicate on the unique `webhook-id`.
  - Reply 2xx within about 1 s, then enqueue.
  - **Never reply 4xx for a bot we don't know.** Svix retries for about 28 h and then disables the endpoint. Store the event and reconcile.
- **Environments are separate.** Staging and prod each have their own Recall workspace, keys, secrets and webhook URL (with `?env=`). Handlers reject a `metadata.env` that doesn't match. Recall's secrets go into Secret Manager in **M0**, not R9.

**Creating a bot (idempotent, even when a dead letter is replayed days later).** Recall's `Idempotency-Key` lasts
only **1 hour** ([docs](https://docs.recall.ai/reference/idempotency.md)), so:
1. The create task sends `Idempotency-Key: {meeting_bot_id}` and `metadata {meeting_bot_id, workspace_id, env}`.
2. On **any** retry or replay, it first calls `GET /bot/?metadata__meeting_bot_id=`. If a bot exists, it's adopted, not created again.
3. The queue's `max_retry_duration` is at most 50 min.
4. A 409 is retried; 429 and 507 honour `Retry-After`.
5. A bot sent from a pasted link joins at once, and can hit Recall's **507 "out of ad-hoc bots"**. The user then sees "notetaker busy, retrying".

**Bot settings, all explicit** ([bot_create](https://docs.recall.ai/reference/bot_create.md)):
- `recording_config`:
  - `audio_mixed_mp3: {}`;
  - `video_mixed_mp4: null` (video is on by default, so it has to be turned off);
  - no transcript;
  - `retention {timed, 72 h}`, a backstop behind `delete_media`. New accounts keep media **forever** otherwise.
- `automatic_leave`:
  - `waiting_room_timeout: 600`, the **maximum Google Meet allows**;
  - `noone_joined_timeout: 600`;
  - `everyone_left_timeout: 60`;
  - `recording_permission_denied_timeout: 30`;
  - `in_call_recording_timeout`: the minutes reserved (see Quota).
- `chat`:
  - `on_bot_join {send_to: everyone, pin: true}`;
  - `on_participant_join`, so late joiners also see the notice.
- The bot name is truncated to Recall's 100-character limit.

**Webhooks and ingest.**
- Every event is matched on `data.bot.metadata.meeting_bot_id`, so it still works when the webhook beats the commit of `recall_bot_id`.
- `status_rank` makes the order of arrival irrelevant.
- **Ingest waits for both `audio_mixed.done` and `participant_events.done`** ([recording webhooks](https://docs.recall.ai/docs/recording-webhooks.md)), not just `bot.done`.
- `audio_mixed.failed` becomes a note error, with **no charge**.
- The ingest task (`ingest-{meeting_bot_id}`):
  1. re-reads the bot from Recall;
  2. fetches the download URL **at that moment** (it's never stored);
  3. streams the audio to the fixed object `recordings/{ws}/{noteId}.mp3`, so a replay just overwrites;
  4. stores the participants and the speaker segments;
  5. calls `queueNoteRun()`;
  6. calls `POST /bot/{id}/delete_media/` and confirms `recording.deleted`.
- **SSRF protection on the download:** HTTPS only, a host allowlist confirmed in the spike, no cross-host redirects, a size cap and a timeout.

**Creating the note: `createServerNote` (in the repo).**
- It writes the Postgres row, then its mirror doc, which must carry `authorId`, `workspaceId`, `title`, ISO `createdAt`/`updatedAt`, `status` and `type`.
- The mirror doc must exist first, because `markQueued` refuses a note with no doc (`notes-repo.ts:323`).
- Mirror failures are repaired by `mirror_repair`.
- When it's created:
  - a bot from a pasted link: straight away;
  - a calendar bot: at the first `joining_call`, so cancelled meetings leave no empty notes.

**Kickoff: `queueNoteRun()`** is extracted from `process-intelligence.js:107–317`.
- It takes out the HTTP coupling (`req.headers`, status codes) and returns a typed result. The api maps that to HTTP; the worker maps it to note and bot state.
- It lives in `packages/db`, which already depends on `@algominutes/ai` and already enqueues through `notify.cjs`.
- It checks the note hasn't been deleted **inside** the transaction.

**Speaker names, with one STT pass and no per-participant cost.**
- **The function:** `packages/ai/src/speaker-align.cjs` `alignWords(words, segments)`. It:
  - picks the segment with the most overlap;
  - allows a small clock skew;
  - carries the last speaker through gaps;
  - labels unmatched speech "Unknown speaker";
  - assigns tags **1..N**, because tag 0 is stored as NULL (`pipeline-repo.cjs:276`).
- **Where it runs:** in the Google STT poll before `wordsToLines` (`handler.js:559`), and in the provider path (`providers/neutral.js`) for R6.
- **The chunked path:** bot notes always take it, because the fast path has no word timings. The kickoff payload carries `forceChunked`, derived from `source_kind='bot'`.
- **The time base:** alignment uses the recording's `absolute` start. Recall's `relative` is measured from the **latest** `in_call_recording`. So bots never pause recording, and a bot with more than one recording is flagged.
- **Names never override the user:** they seed `note_speakers` with `DO NOTHING`, **once, at first ingest**, so a rename wins. Clearing a name falls back to "Speaker N" by design (`note-read.cjs:267`).

**Tenancy (fixes the blocker).**
- One bot gives one note in one workspace, owned by the user who asked for it.
- The calendar dedup key is `{start}-{meeting_url}-{workspace_id}`. Recall's suggested key would share one bot across all our customers.
- A second workspace in the same meeting gets its own bot, its own charge and its own notice. Nothing is ever added to another user's note automatically.
- The uniques include `workspace_id`.
- Test: two workspaces in one Meet, each sees only its own note.

**Quota (fixes the race).** One transaction under a per-workspace lock:
- reserves notetaker minutes, which also set `in_call_recording_timeout`;
- checks active bots (at most 2 per user) and a global `MAX_ACTIVE_BOTS` counter row.

Minutes are settled to the actual duration at ingest, and released on not-admitted or cancel. A scheduled
`enforce_cap` is only a backstop.

**Races:**
- **Cancel while being created:** a `cancel_requested` flag that the create task honours by calling leave. `DELETE /bot` returns 405 once the bot is dispatched, so leave is used from then on.
- **Event moved:** to less than 10 min away, delete and create an ad-hoc bot (Recall refuses a `join_at` that close). After the bot has joined, moves are ignored.
- **Delete during ingest:** checked inside `queueNoteRun`'s transaction, then the GCS object is removed and a purge is queued.

**PII:**
- **Non-users:** display names only, with participant emails off. They're deleted with the note and included in data-access requests.
- **Meeting URLs** (Zoom `pwd=`, Teams tokens): encrypted at rest with KMS, cleared after the bot joins, and logged only as platform plus a hash.
- **Task bodies:** ids only.
- **Zoom tokens:** KMS envelope encryption per environment, bound to the uid.

**Older app builds (verified):**
- iOS parses notes by hand (`Note.swift:166–177`): an unknown status becomes `.processing`, an unknown type becomes `.recording`, and extra fields are ignored.
- Web **drops** a note with an unknown status or type (`notesFeed.ts` `safeParse`).
- **So:** only existing values are used (`status: recording`, `type: online_meeting`). New data goes in optional fields (`notetaker`, `sourceKind`) as open strings with an unknown fallback.
- **Rollout order:**
  1. contracts;
  2. tolerant clients;
  3. server writes, behind the kill switch;
  4. a min-version bump.
- The current TestFlight build is tested against a server-created, audio-less `recording` note before any tester sees one.

**Data (migration 023, expand-only; integration ends at 022), in `meetings-repo`:**
- `calendar_accounts`: `recall_calendar_id` only; Recall holds the refresh token, which the privacy page discloses.
- `oauth_states`: single use, 10-minute TTL, bound to the uid and workspace, with PKCE S256.
- `calendar_events`.
- `meeting_bots`:
  - UNIQUE `note_id` and `recall_bot_id`;
  - UNIQUE (workspace, request id);
  - partial UNIQUE (workspace, event) and (workspace, url hash) while active;
  - `cancel_requested`, the reserved minutes, `status_rank`, and the encrypted URL.
- `recall_events`: unique `webhook_id`, append-only.
- `meeting_participants`, `meeting_speaker_segments`, `notetaker_settings`.
- `recall_purges`, inside the transactions of `deleteNote` (`notes-repo.ts:925`) and `deleteAccountData` (`account-repo.ts:104`). `finishAccountDeletion` waits for them and deletes Recall calendars.
- `meeting_consents`: the notice version and text, when it was sent, admission, and recording permission.
- `notes` gains `source_kind` and `platform`, and reuses `source_url` (with any password stripped), `meeting_at` and `participants`.

**Failure handling:**

| Case | Handling |
|---|---|
| Duplicate or out-of-order webhook | a no-op, by the unique `webhook-id` and `status_rank` |
| Webhook before our commit | stored, 2xx, reconciled |
| Not admitted, permission denied, or `google_meet_bot_blocked` | a clear error, **no charge**, reservation released |
| `fatal`, or `audio_mixed.failed` | error, dead letter, alert |
| Media never arrives | the sweep reconciles at 45 min; failed at 6 h |
| Note or account deleted mid-meeting | the bot leaves, Recall's media is purged, and a late media event only purges |
| Recall outage | retried, then error; runbook: kill switch, then bulk-cancel scheduled bots, because bots already scheduled in Recall still join otherwise |

**Contracts (three-client, models regenerated), `schemas/meetings.ts`:**
- `POST /v1/meetings/bots` and `…/cancel`;
- `GET /v1/meetings/upcoming` and `…/{eventId}/record`;
- `POST /v1/calendar/connect`, `GET /v1/calendar/accounts` and `…/disconnect`;
- `GET` and `PUT /v1/notetaker/settings`;
- `Note.notetaker {botId, status, failureReason, platform}` and `sourceKind`, all optional and open strings;
- `AppConfigResponse.notetaker {bot, calendar, zoomImport, extension}`.

**Operations:**
- **Alerts:**
  - fatal and not-admitted rates;
  - ingest older than 45 min;
  - signature failures;
  - Recall 5xx and 429 rates;
  - Recall's "endpoint disabled" email, going to both inboxes.
- **Spend:** a db-job polls Recall's usage hourly (its limit is 5/min) and alarms if it drifts from our meter.
- **SLO:** p95 of 5 minutes or less from media ready to `queued`.
- **A runbook**, in `docs/runbooks/meetings.md`.

**Tests:**
- **CI:** a **Recall fake** with fault injection: 409, 429, 507, timeouts, duplicate and out-of-order webhooks, and a webhook before our commit. It's driven by scrubbed payloads captured in the spike.
- **Nightly on staging:** a live bot joins an open test-Workspace Meet that plays a two-voice fixture.
- **Calendar tests** create their events through the Calendar API.
- **A burst test** of 20 bots, exercising the 507 and 429 paths.

### M0: foundations (week 1)
- **The decision PR (docs only):**
  - an ADR on meeting capture;
  - DECISIONS entries: the bot and Mac come into scope, the meetings service and its cost, and the Recall region;
  - a CONSENT amendment: bot visible, a chat notice on join, auto-join off by default.
- **A Recall spike on staging.** Two Recall accounts in **ap-northeast-1 (Tokyo)**, one for staging and one for prod.
  Tokyo is the closest region; there's no Australian one, and the region is per account. Every check has a pass
  criterion:
  1. **Time base:** a clap test shows the MP3's zero and the timeline's `absolute` start agree within 250 ms.
  2. **Admission:** a guest bot is admitted to a personal-account Meet and to a Workspace Meet.
     - Record when it's auto-declined ("Anyone with the link can ask to join" off) and when it's `google_meet_bot_blocked`.
     - Only people in the host's organisation can admit it.
  3. **Deletion:** `delete_media` followed by `recording.deleted` works, and a retention of 72 h is honoured.
  4. **Idempotency:** `Idempotency-Key` behaves as documented, and `metadata__meeting_bot_id` search finds the bot.
  5. **Media host:** the download URL's host is recorded, for the SSRF allowlist.
  6. **Billing:** whether Recall bills time spent in the waiting room (capped at 600 s, at most about US$0.08 a bot).
  7. **Fixtures:** scrubbed webhook and API payloads are captured for the CI fake.
- **Start the long lead times now:**
  - Google OAuth verification for the calendar scope;
  - the Zoom Marketplace app (4–6 weeks);
  - Chrome Web Store and Edge developer accounts;
  - Recall's startup rate.
- **Only if guest admission fails too often:** a dedicated paid Google Workspace with SAML for a signed-in bot. Its
  account name overrides `bot_name`, so name it "AlgoMinutes Notetaker".

### M1: a Meet notetaker from a pasted link (weeks 1–3, staging, allowlisted testers)

| # | PR (one concern each) | Evidence |
|---|---|---|
**Prerequisites before any tester:**
- **R1 and R2** have landed. R2's `recording` sweep can land after PR 5.
- **The owner has applied PR 6's Terraform and added the Recall secrets.** Until then, PR 7 onward merge but aren't deployed to a live bot.

| # | PR (one concern each) | Evidence |
|---|---|---|
| 1 | docs: ADR, DECISIONS (scope reversal, the meetings service's cost, the Recall region), CONSENT amendment | review |
| 2 | contracts (`meetings.ts`: optional fields, open-string enums), the `/v1/config` notetaker switch (off), and api stub routes returning 503 `feature_disabled` | contract and route-check tests; a test that the switch defaults to off |
| 3 | tolerant clients: web and iOS read the new optional fields and show a `recording` note as "Notetaker in the meeting" | a web fixture test and iOS unit tests; the current TestFlight build is checked against a server-created `recording` note |
| 4 | refactor: `queueNoteRun()` extracted into `packages/db`, and `/v1/process` refuses a note still in `recording` (409) | tenant-isolation, first-writes and contract-route tests pass **unchanged**; a new 409 test |
| 5 | migration 023, `meetings-repo`, `createServerNote` (Postgres, then the mirror doc) | expand check; the same webhook twice gives one row; out-of-order; webhook before commit; **two-workspace isolation**; the quota reservation under concurrency (two parallel creates, one wins) |
| 6 | Terraform: the meetings service, the `meetings` queue (`max_retry_duration` of 50 min or less), secrets, connection budget (staging has 25 connections, so it's checked), public-service list, `tf-iam-contract` update | staging plan (the owner applies it); tf-iam and connection-budget tests |
| 7 | meetings skeleton: health, OIDC check on `/tasks`, webhook verification (raw body, every signature, two secrets, ±5 min, env check), store-then-2xx | signature fixture tests, including a bad signature, rotation, replay and a mismatched env; a signed staging POST writes one row |
| 8 | `processing.json` adds Recall (Tokyo, outside Australia); privacy page APP 5 and APP 8 wording; site-facts test | CI pins the processor and its region to the code. **This lands before PR 9 reaches any tester.** |
| 9 | create, adopt and cancel a bot (allowlisted), with explicit bot settings and the chat notice | CI fake covering 409, 429, 507, replay after 1 h (adopted, not duplicated), and cancel during create; live: the bot joins a staging Meet with the pinned notice; one traceId from the api through meetings |
| 10 | ingest (two-event trigger, SSRF-safe download, `delete_media` and its confirmation) and the purges | replaying ingest twice leaves one charge (psql); Recall media deleted (Recall API); `audio_mixed.failed` gives an error with no charge |
| 11 | `speaker-align`, the transcoder hook and `forceChunked` | alignment fixture tests (gaps, overlap, skew, unknown speaker); a two-person staging Meet shows **real names** in `/v1/notes/read`; a rename still wins; clearing a name gives "Speaker N" |
| 12 | sweep reconcile, deletion hooks, and R2's client-`recording` sweep | not admitted gives an error, no charge and the reservation released; deleting mid-meeting purges; a live 2-hour bot note is untouched by the client sweep |
| 13 | web: paste a link, live status chip, cancel | the e2e gate, including a stubbed notetaker flow |

The iOS "send a notetaker" sheet follows in its own PR, using the same contract.

### M2: calendar auto-join (weeks 3–5)
- Google Calendar first (our OAuth client), through Recall Calendar V2. Microsoft Outlook follows.
- An upcoming-meetings list, with a per-meeting "record / don't record".
- Optional rules: meetings I organise, meetings with a video link. Default off.
- **Event changes:**
  - A move updates `join_at`. If the new time is less than 10 min away, the bot is deleted and an ad-hoc one created.
  - A cancelled or deleted event unschedules its bot (Recall does this).
- **Dedup is per workspace only** (see Tenancy). The same user's several calendars never send two bots.
- **Sync:**
  - `calendar.sync_events` carries only a timestamp, so a per-calendar task re-lists with `updated_at__gte`.
  - It's rate-limited to about 0.9 requests/s, because Recall allows 60/min per workspace, and it honours `Retry-After`.
- **Connecting and disconnecting:**
  - Reconnecting uses Recall's **Update Calendar**, never create, which would duplicate bots.
  - Disconnecting deletes Recall's calendar and marks it locally, because Recall sends no webhook for that.
- **Settings:** the bot name ("{First name}'s notetaker (AlgoMinutes)", with the suffix fixed, at most 100 characters) and disconnect.
- **Evidence:**
  - moving an event moves the bot, including a move to less than 10 min away;
  - cancelling cancels it;
  - disconnect, then reconnect, gives no duplicate bot;
  - two workspaces on one meeting get two bots and two separate notes.

### M3: Chrome/Edge extension (weeks 4–7)
- One MV3 build for Chrome and Edge: `tabCapture` in an offscreen document, the mic and the tab on separate channels, and progressive upload (R3).
- On meet.google.com (then Zoom web and Teams web), one click records, or sends the notetaker instead.
- **Sign-in handoff:**
  1. The signed-in web app gets a one-time code (`POST /v1/auth/extension-link`). The code is valid for 60 s, can be used once, and is bound to the uid, the extension id, and a verifier the extension creates.
  2. The web app passes the code over `externally_connectable`, which lists the exact web origin. The extension checks `sender.origin`.
  3. The extension exchanges the code for a Firebase custom token. Its session lives in `chrome.storage.session`.
- **The client header is `extension/x.y.z`.** Unknown platforms already pass the gate (`client-version.js:118`), so
  `extension` goes into `MIN_SUPPORTED_CLIENTS` **from its first release** to turn gating on.
- **CORS:** `ALLOWED_ORIGINS` lists **both** the Chrome and the Edge extension origins, which have different ids
  (`cors.js` is exact-match).
- A new `POST /v1/notes` endpoint, reusing `createServerNote`.
- Chrome Web Store and Edge Add-ons review.

### M4: Zoom and Teams (weeks 6–9)
- Zoom and Teams **bots** work with the same code, because Recall is platform-agnostic: turn them on and test each platform.
- **Zoom cloud-recording import:**
  - User-level OAuth (least scope, cloud recordings read only), with tokens under KMS envelope encryption and bound to the uid.
  - Zoom's webhooks are verified by their signature and endpoint-validation challenge, and de-duplicated by event id.
  - The `recording.completed` webhook fills a `cloud_recordings` table, keyed uniquely on Zoom's recording id.
  - Downloads use the same SSRF guard (Zoom hosts only).
  - Import is a task: M4A to GCS, then `queueNoteRun`.
  - Zoom's own timeline feeds `speaker-align`.
  - The deauthorisation webhook deletes the tokens.
- Meet import (Workspace Business Standard or above, restricted scopes) and Teams import (Graph, admin consent) come later, on demand.

### M5: Mac app (weeks 9–14)
- A SwiftUI multiplatform target that reuses the iOS services (recorder, uploads, APIClient).
- A menu-bar app captures the Zoom and Teams desktop apps with **Core Audio process taps** (macOS 14.2+). No bot and no per-hour fee.
- It auto-detects a meeting and asks before recording.
- Distributed with a Developer ID and notarised, or through the Mac App Store; the sandbox choice gets its own spike.

### Cost (US$ per meeting-minute; R4 replaces these with measured numbers)

| Item | Cost |
|---|---|
| Recall bot | 0.0083 (0.0042 at the startup rate, first 10k h) |
| Google STT today | ~0.016 |
| AssemblyAI (R6) | ~0.0033 |
| Gemini and the rest | small |

- **With the bot and Google STT, a 1-hour meeting costs about US$1.45.** So Pro at 600 notetaker minutes costs
  about **US$14.60**, more than Pro's price (A$14.99, about US$9.80).
- **After the R6 switch to AssemblyAI,** the same 600 minutes cost about **US$7.00**, or about US$4.50 at Recall's
  startup rate.
- **Proposal:**
  - Until R6 and R4 land, notetaker minutes go **only to allowlisted and trial users** (trial: 60 min).
  - After that: Pro 600 min, free 0.
- **Final quota and price:** the owner's decision, once R4's measured numbers are in.

### Gates only the owner or outside parties can clear (lead times start in M0)
- A **legal opinion on recording** (NSW requires all parties' consent; the bot's visibility and chat notice are the design answer). Terms and Privacy updated for Recall, Zoom and Google. Needed before any external user.
- Contracts and accounts:
  - the Recall account (Tokyo), its DPA and no-training confirmation;
  - the AssemblyAI DPA;
  - Google OAuth consent screen and verification;
  - a Zoom Marketplace app;
  - Chrome Web Store and Edge developer accounts;
  - Apple Developer ID for the Mac app;
  - a paid Google Workspace with SAML, only if a signed-in Meet bot turns out to be needed.
- **Secrets into Secret Manager, and every `terraform apply`:** the owner's. The Recall
  secrets are needed in M0.

## Verification (per milestone, with evidence)
- **R1:** a ready staging note on each Gemini rung; the tripwire goes red for a rung past retirement.
- **R2:** a mutation-checked test for each limit (fetch timeout, ffmpeg timeout, duration cap, `recording` gets 409, metering inside the transaction, spend cap at kickoff).
- **R3:** a 2-hour web recording survives killing the tab, and upload completes within 10 s of stopping.
- **R4:** `cost_usd` is filled on new events (psql), and the measured cost per minute on each path is recorded in DECISIONS.
- **M0:** all seven spike checks pass, and their results are recorded.
- **M1:**
  - **Speaker names:** a real two-person Meet on staging gives a note with **both names** on the transcript lines.
  - **Idempotency:** replaying every webhook and every task twice, plus a create replay more than an hour later, leaves **one bot, one note, one charge** (psql plus Recall's bot list).
  - **Unhappy paths:** not admitted, or `audio_mixed.failed`, gives an error, no charge, and the reservation released.
  - **Deletion:** deleting mid-meeting means the bot leaves and Recall's media is deleted (Recall API, and `recording.deleted` received).
  - **Tenancy:** two workspaces in one Meet each see only their own note.
  - **Old builds:** the current TestFlight build shows a server-created `recording` note correctly.
  - **Tracing:** one traceId followed across api, meetings, transcoder, summarizer and notifier.
  - **Webhook security:** a bad signature, a replayed timestamp or a mismatched env are all refused, and are never 4xx for a bot we don't know.
- **M2:** moving an event (including to less than 10 min away), cancelling it, and disconnecting then reconnecting all behave as described, with no duplicate bots.
- **M3:** the store build records a Meet tab with You/Others split, and the extension header is version-gated.
- **M4:** a Zoom cloud recording arrives as a note with Zoom's speaker names; deauthorising deletes the tokens.
- **M5:** a Zoom desktop call on macOS 14.2+ becomes a note with no bot in the call.
- **Launch:** prod (R10) is applied, the kill switch is flipped per surface, and the site smoke and SLO dashboards are green.

## Risks
- **Recall has no Australian region.** Disclosed (APP 8); the processor is pinned in CI; media is deleted after
  ingest, with a 72-hour retention as a backstop.
- **Google Meet may keep a guest bot waiting, or refuse it.** Only people in the host's organisation can admit it;
  guests are auto-declined when "Anyone with the link can ask to join" is off; and Google can block bots. Handled by
  the 600 s timeout, a clear error with no charge, and a signed-in bot if the spike shows it's needed.
- **Recall disables a webhook endpoint after 5 days of failures.** Handled by store-then-2xx, never a 4xx for an
  unknown bot, an alert on its "endpoint disabled" email, and a reconcile sweep.
- **Recall runs out of capacity for immediate bots (507).** Pasted-link bots retry, honouring `Retry-After`, and
  the user is told. Calendar bots are scheduled more than 10 min ahead, which avoids it.
- **Platforms change their policies.** Recall absorbs that for bots; the extension and the Mac app are fallbacks that need no bot.
- **Unit economics:** the R4 gate comes before opening meetings to anyone.
- **Scope:** every milestone ships behind the kill switch, so it can be cut at any milestone without leaving half-built UI.
