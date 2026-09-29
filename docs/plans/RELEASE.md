# Release plan: a great beta on iPhone and Chrome, then production ready (rev 10, 2026-09-29)

> Approved by the owner on 2026-09-29. The waves, PR order and gates below are the plan of record; update this
> file in the PR that changes them. Evidence for each step goes into `docs/BLOCKERS.md`.

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
| 22 | `feat(api,ios)` real DeviceCheck (S3-PR3) | Apple's two-bit API: the server validates the token and reads or sets "trial used". The hash seam is retired |
| 23 | `feat(web,ios)` PR 3 clients understand notetaker notes | "Notetaker in the meeting", a live status, the failure reason, cancel |
| 24 | `feat(web)` PR 13 send a notetaker | Paste a Meet link, the CONSENT §2.4 tick box (the create contract has no field for it, so the UI enforces it, with a test), a status chip, cancel |
| 25 | `feat(ios)` send a notetaker, and rename speakers | The same sheet, plus the tap-to-rename speaker chip (BL:134) |
| 26 | `feat(billing)` purchases you can trust (S3-PR10) | • App Store Server API lookup<br>• sandbox accepted **on staging only**<br>• the reconcile job (BL:205)<br>• a pre-purchase entitlement check (BL:209)<br>• `EntitlementResponse.source` (S2-PR6e / BL:158), so a grant isn't counted as a purchase<br>• deploy workers before the api (Q25) |
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
- **Caps:** the staging daily cap (your figure), 600 minutes per invite per 30 days, and the notetaker defaults of
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
