# Blockers & handoffs — AlgoMinutes

Batched list of everything that needs a human decision or credential. Nothing here stopped the A2/A3
run; each item has a safe reversible default already applied. Grouped by type.

## 1. Needs your action before/at A4 (repo & infra)

- [ ] **Enable branch protection (yours).** `main` and `integration` are pushed and in use (PRs into
      `integration`, promotions to `main`). Neither branch is protected yet: the GitHub API answers "Branch not
      protected". Run `scripts/github-settings.sh --apply` (required checks, no direct pushes, the approval-gated
      `production` Environment).
- [ ] **Rotate the exposed Gemini API key + purge source history** (EXTRACTION-AUDIT §5). Source-side,
      in `~/src/wasssup-meeting`; not touched by this run.

## 2. A4 provisioning

**Staging: paused since 2026-08-27** (Cloud SQL `activation_policy` NEVER, no Cloud Run services). Firebase
is enabled (Blaze), Google sign-in on, Web, Android and iOS apps registered (the configs are git-ignored).
Resuming it is one reviewed `terraform apply` (runbook `resume-staging-and-deploy.md`), then the first
deploy. Enable **Anonymous** and **Apple** sign-in too (the iOS app needs both). **Prod: ⏳ pending.** Remaining, all from a primary-account (`algorythmos.france@gmail.com`) shell:

- [ ] **Apply prod:** bootstrap `algominutes-prod-tfstate`, then `terraform apply` in
      `infra/terraform/envs/prod` (runbook `gcp-provisioning.md`).
- [ ] **Prod Firebase:** enable Firebase (Blaze), Google sign-in, register Web + Android apps, download a
      **fresh** `google-services.json` + create a **prod** `apps/web/.env` — never reuse staging's values
      (runbook `prod-firebase-config.md`).
- [x] **Migrations run on every deploy:** the db-job `migrate` handler runs before rollout (PR-08b), and
      migrations are expand-only. Nothing to run by hand; staging just needs your apply first.
- [ ] **Re-scope `algominutes-prod-budget`** from the whole billing account to the prod project only
      (INFRASTRUCTURE open item #2 — still outstanding).
- [x] **Domain decided (2026-09-26):** `algorythmos.com` (owned; Cloudflare DNS, Zoho mail). The site is
      `algominutes.algorythmos.com`, mail is `support@` / `privacy@algorythmos.com`, and the api keeps its
      `run.app` URLs (DECISIONS). `algominutes.com` is **not registered**, so nothing may point at it: the
      server moved in #170, the iOS app in its "nothing to trip on" PR. The web's `apiUrl.ts` still names
      `api.algominutes.com`; the web isn't deployed, and it moves with its `/v1` migration.
- [ ] **Owner:** turn on auto-renew for `algorythmos.com` (expires 2026-12-06); add the Zoho aliases.
- [ ] Staging's **Browser** API key (auto-created by Firebase) allows the referrers `localhost` and
      `https://algominutes.com/*`. Set it to the real site before any web deploy. Referrers can be
      spoofed by non-browser callers, so this is hygiene, not access control.
- ~~**iOS Firebase app pending the Apple Team ID**~~ **done (2026-09-25):** the iOS app is registered in
  `algominutes-staging`; its `GoogleService-Info.plist` stays git-ignored and reaches Xcode Cloud as the
  `GOOGLE_SERVICE_INFO_PLIST_B64` secret (`xcode-cloud.md`). Android upload keystore still pending (Track B).
- Incidental finding (A5/A8, not A4): `apps/web/src/lib/apiUrl.ts:1` hardcodes the prod API origin
  (now `https://api.algominutes.com`, an unregistered domain), and the web ignores `VITE_API_BASE_URL` on
  local/capacitor hosts in favour of it. The web isn't deployed; fix it with the web's `/v1` migration,
  before any web deploy, so no ID token is ever sent to a domain we don't own.

See also the dedicated section at the bottom: **"A4 identifiers needed from you"** (now mostly supplied).

## A10 launch blockers — needs YOU (legal / brand / infra)

**Legal (`TODO(legal)`) — highest priority, blocks the consent layer + listings:**
- [ ] **State-by-state / export-market recording-consent opinion** — NOT commissioned. Blocks the full
      consent layer (jurisdiction, per-participant log, audible announcement). The seam is built; the rules
      must not be guessed.
- [ ] **Terms of Service + Privacy Policy** drafting/review — must be linked from both store listings, the
      consent notice, the deletion page, and signup. Blocking.
- [ ] UGC/moderation applicability + final age rating; MediaProjection justification vs current Play policy;
      any billing/tax minimum-retention obligation; confirm the 30-day retention figure so the plist,
      policy, and deletion page all match.

**Brand (`TODO(brand)`):**
- [ ] All store imagery (screenshots, icon, feature graphic, app-preview video) — blocks the listing.
- [ ] The public deletion-page domain + a support/privacy email address — blocks Play submission.

**Infra (`TODO(A11)`):**
- [x] **Done (retention-windows PR, pending your apply):** Cloud SQL keeps 7 daily backups and 7 days of PITR
      logs; noncurrent object versions expire after 7 days (#70); the `_Default` log bucket keeps 30 days. All are
      stated in Terraform so they can't drift past the 30-day deletion promise, and DATA-RETENTION §4 shows how
      to verify them. The retention enforcer and trial-expiry sweep are also done (#81).
- [ ] Server-side attestation verification (DeviceCheck key / Play Integrity) so the #7 device hash is
      trusted, not just accepted; needs a real device to verify end-to-end.

**Engineering follow-ups (no external input):**
- [x] **One account-deletion path:** `/v1/account/delete` (#69; Postgres first, retried by the sweeper), and
      the iOS client calls it (iOS PR-17 B). The old Cloud Function is gone with `functions/` (#84). The web's
      Settings modal moves with its `/v1` migration.
- [x] **Done (analytics-compliance-events PR):** the server records `terms_accepted`, `retention_set`,
      `support_requested` and `account_deleted` (counted once, with no uid) after each succeeds. They form a
      separate `ServerAnalyticsEvent` in the contracts, so a client can't post them to `/v1/events`, and the
      client contract is unchanged. Was: Extend `AnalyticsEvent` with support/terms/retention/deletion events + emit them (funnel is complete
      without them).
- [x] **Fixed (ios-m0-readiness PR):** one upload cap. The api refuses anything over 500 MB at
      `/v1/uploads` (#97), and the app now checks the same 500 MB before it starts (`StorageKind.maxBytes`).
      Was: iOS `StoragePaths.maxBytes` said 50 MB against a 120 MB doc.

## Diarisation launch blockers — needs YOU (AssemblyAI go-live)

The engine swap is built behind a seam (`STT_PROVIDER`, default `google`). Flipping to `assemblyai` in
production is gated on these — none are code, all are ops/legal/infra. Evidence for the retention items is
`docs/audits/DIARISATION-VENDOR-RETENTION.md`.

**Ops (`TODO(ops)`) — blocks flipping `STT_PROVIDER=assemblyai`:**
- [ ] **Opt out of AssemblyAI's model-improvement program on a PAID account.** AssemblyAI trains on customer
      data BY DEFAULT and **free-tier accounts cannot opt out**. Opt out via the dashboard Data Controls page
      or data-opt-out@assemblyai.com. Do NOT point `ASSEMBLYAI_API_KEY` at a free-tier key. (Code already
      deletes each transcript after persist and Deepgram sets `mip_opt_out=true`, but the AssemblyAI training
      opt-out is account-level and cannot be set per request.)
- [ ] **Put `ASSEMBLYAI_API_KEY` (+ `DEEPGRAM_API_KEY` for the failover) in Secret Manager** and wire them to
      the transcoder Cloud Run service. Never commit keys. Optionally set the account audio-retention TTL to
      the 1-hour minimum.

**Legal (`TODO(legal)`) — APP 8 cross-border:**
- [ ] **Execute the AssemblyAI Data Processing Addendum** (effective 2026-01-22; SCCs + Data Privacy
      Framework) before production audio flows to the US. Deepgram DPA/BAA only if/when Deepgram is enabled.
- [ ] **Consent opinion must cover cross-border disclosure (APP 8).** The privacy-policy draft now states
      US processing + APP 8 accountable-disclosure wording (`apps/web/src/pages/PrivacyPolicy.tsx`); legal
      must confirm the wording and that reasonable steps + accountability (APP 8.1) are satisfied. This rides
      alongside the existing recording-consent opinion item above.

**Infra (`TODO(A11)`):**
- [ ] **VPC egress to `api.assemblyai.com` (and `api.deepgram.com`).** Cloud Run runs behind the VPC
      connector + private IP; confirm the audio-egress path to the vendor is allowed (Cloud NAT / egress
      rule). The Vertex private-IP setup does not cover third-party public endpoints.
- [ ] **A11 measures real blended COGS/min** (AssemblyAI + Gemini + storage) BEFORE `FREE_FLOOR_MINUTES` and
      the Pro included-minutes cap are fixed. The plan's cost figures are list prices, not measured.

**Client follow-ups (diarisation rename UX — the plan's #2 cut):**
- [ ] **iOS tap-to-rename chip.** The endpoint + map + `APIClient.setNoteSpeaker` + the decode fix (server
      speaker now wins) are built and UNBUILT-in-session (no Xcode/simulator). Remaining: make the speaker
      chip tappable → rename alert → call `setNoteSpeaker` → refresh the transcript (TranscriptRepository is
      idempotent-per-note, so it needs a forced reload or an optimistic in-place label update keyed on the
      new `TranscriptLine.speakerTag`). Compile + device-test all iOS edits before ship.
- [ ] **Web rename is blocked by architecture.** The web renders the Firestore mirror preview
      (`{speaker, time, text}`, no `speakerTag`), so it ships raw "Speaker N". To add a web chip, either
      carry `speakerTag` through the mirror or move the web onto the API transcript read (iOS's `/api/note`),
      then add the chip + `authedFetch('/v1/notes/:id/speakers')`.

**Cannot verify without the above:**
- [ ] **Shadow eval old-Google vs AssemblyAI on a real 2-speaker >30-min file** (harness built —
      `services/db-job/src/handlers/eval-diarisation.js`, fixtures in `evals/diarisation/`) needs a live
      AssemblyAI key + a labelled real recording. Not run in this session (no key, no network to the vendor).
      Must clear the DER/boundary gate before cutover — do NOT flip `STT_PROVIDER` without it.

- [x] **Fixed (tester-grant PR): internal testers couldn't process a recording.** `FREE_FLOOR_MINUTES` is
  unset (0), and a TestFlight build has no DeviceCheck token, so `ensureTrial` opens the user on the free
  floor and the first `/v1/process` answered 402. A manual grant (`entitlement_grants`, migration 019)
  now makes `resolveEntitlement` treat the user as `active` on Pro (1,500 min/month, or `GRANT_MINUTES`).
  A real paid subscription still wins, and only Pro can be granted (team is unmetered). The owner adds
  grants with the db-job `grant-tester` handler (runbook `resume-staging-and-deploy.md` §4); no tester
  email goes into git or the logs. Tested (grant, expiry, another user, usage, paid wins, revoke, account
  deletion, the handler); four mutations checked.
  - [ ] **Queued (audit of that PR): say where an `active` entitlement comes from.** A grant reports
    `active` like a paid subscription, so iOS `BillingService` logs a `purchase` event when a grant starts
    (and `cancellation` when it ends), and the web paywall offers only "Manage subscription", whose portal
    answers 409 (no Stripe customer). Fix: an additive `source` field on `EntitlementResponse`
    (`subscription` | `grant` | `trial` | `free`), a contract change for all three clients, and have the
    clients skip funnel events and the portal for a grant. Not on the M1 path (internal testers).

## 3. Business/engineering decisions deferred (safe default applied)

Full rationale for each is in `docs/DECISIONS.md`. The ones a human may want to revisit:

- **db-job → scheduled Cloud Run job** (not folded into `api`). Reversible.
- **Web keeps client-side extraction** (pdfjs/mammoth/tesseract) for now; switching the web to call
  `services/extractor` is a follow-up.
- **All `shared/` lives in `@algominutes/ai`** (incl. pg-query/storage-paths). If you'd prefer pg-query in
  `@algominutes/db`, it's a small move (the service `sharedRequire` ai→db fallback already tolerates it).
- **`main` not pushed / not protected during this run** (see §1). 
- **A5 rename follow-ups (need Apple/infra, not code):**
  - ~~iOS `Info.plist` reversed-OAuth URL scheme still references the OLD client OAuth id~~ **fixed:** the
    build writes the scheme from `GoogleService-Info.plist`'s `REVERSED_CLIENT_ID` (#174 orders it after
    Info.plist), and `AppConfigTests` fails if `909388484461` comes back.
  - ~~Backend domains `api.algominutes.com` / `algominutes.com`~~ **decided:** `algominutes.com` is
    unregistered; see "Domain decided" in §2.
  - ~~The **app-side** iOS entitlements has no `application-groups` entry~~ **done (#125):** both targets
    carry `group.com.algorythmos.algominutes`, registered on both App IDs 2026-09-26.
  - Minor: the web "Sign in with Google" mark is a single indigo tint, not Google's official multicolour
    branding — revisit for store/brand compliance (pre-existing, not introduced by the rename).
- **A9.3/A6.3 are now DECIDED** (reverse trial + guest mode) and the billing rails are built. Remaining
  A9 items need your credentials/decisions:
  - **`FREE_FLOOR_MINUTES` is UNSET → free floor = 0 metered minutes (fail-safe).** The post-trial free
    tier does NO metered work until you set the number in `@algominutes/contracts` limits.ts after A11
    measures blended COGS/min. **Ship-blocker for the free floor** — shipping a guessed number risks an
    unbounded bill (A9.3). Pro included minutes (1500) is also config, confirm post-COGS.
  - **Billing credentials (Secret Manager, per env):** Stripe secret + webhook signing key + price ids;
    Apple App Store Server API key (`TODO(A4-apple)`) + App Store Connect products; Google Play service
    account + RTDN Pub/Sub topic + Play Console products. Receipt validation + webhooks are coded but
    untestable here (`TODO(A11)`).
  - **App Review 3.1.3:** iOS paywall shows StoreKit pricing only (no web-pricing reference) — safe
    globally; if you later want to surface the cheaper web rail on iOS it's US-storefront-only (see DECISIONS).

### ⚠️ Trial state-machine fragilities (you asked me to flag these)
  1. **Reinstall-restart abuse (the big one).** No-account-for-7-days + anonymous identity means a user can
     delete + reinstall to get a fresh anonymous uid and a new 7-day trial. The server keys the trial to
     uid and `ensureTrial` is idempotent per-uid, but a *new* uid escapes it. The `trial_device_hash` column
     is a **seam, not enforced.** Fix needs a durable device signal — iOS DeviceCheck/App Attest (1 bit per
     device) and Android Play Integrity — or gating trial-start behind a lightweight identity. **Decision +
     platform work required before launch.**
  2. **Missed cancellation/expiry webhook → over-grant.** Entitlement is derived from `current_period_end`;
     if an EXPIRED/cancel webhook is dropped, the user stays `active` until the stored period lapses. Needs a
     periodic reconciliation job (poll Apple/Stripe/Google status) + the `expireElapsedTrials` sweep on a
     schedule. Not built (no scheduler wired — A11/infra).
  3. **Cross-rail double-charge race.** The client hides "buy" when already entitled and the server logs
     `cross_rail_duplicate`, but two near-simultaneous purchases (or a user ignoring "already subscribed")
     can still double-charge, and a store charge can't be auto-refunded server-side — must be surfaced to
     support. Consider a server pre-purchase entitlement check.
  5. **Client billing endpoint wiring (TODO(A9-infra)).** The iOS client uses provisional paths
     (`api/verify-purchase`, `api/entitlement`) that must be reconciled with the deployed routes: verify
     lives on **services/billing** `POST /v1/purchases/verify` (a separate service base URL, not the api),
     entitlement is **api** `GET /v1/entitlement`, events is api `POST /v1/events`. The web client already
     uses the correct paths. Reconcile the iOS APIClient base URLs/paths when the services deploy (A11).
  6. **Android Play Billing CLIENT is B2.** The Play *server* side (verify + RTDN webhook) is built in
     services/billing; the Android in-app Play Billing Library flow (products, purchase, restore) ships in
     Track B, calling `POST /v1/purchases/verify` with `{purchaseToken, productId}`.
  4. **Trial vs monthly-quota window mismatch (minor).** The trial is an absolute 7-day window; metered
     quota resets on the calendar month (UTC). A trial crossing a month boundary gets a fresh monthly
     bucket — bounded and low-risk, noted for awareness.
- **A9.4 blended cost-per-minute not measured** — gates pricing (needs A11 deployed pipeline). The
  1,500-min Pro tier at A$14.99 (~A$12.74 net) breaks even at ~0.85¢/min, so COGS must be well under that.
  See PERFORMANCE-BUDGET.md.
- ~~**A7.2 background upload is gated OFF by default**~~ **done (#101):** every recording uploads through
  `/v1/uploads` on a background URLSession (the Firebase `putFile` path and its flag are gone). Still to
  prove on staging: the GCS resumable session against live GCS, and a device upload after the app is killed.
- **A7.3 real push (plan rev 8, Wave 3):** ~~the app sends the raw APNs token where the notifier expects an
  FCM one~~ **fixed (ios-fcm-token PR):** FirebaseMessaging exchanges the APNs token for the FCM token, and
  `PushTokenRegistrar` registers it once per signed-in user (again for a new token or user, again after a
  failure) and deletes it on sign-out, so the previous user's pushes stop reaching the device. Unit-tested.
  - [ ] **Owner:** enable Push on the App ID and upload an APNs `.p8` to Firebase (staging, then prod).
  - [ ] **Then (one line):** add `aps-environment` to `AlgoMinutes.entitlements`. Not before: an
    entitlement the App ID lacks fails the archive's signing (M0). Until then APNs registration fails
    harmlessly and local notifications carry the message. Prove it on a device (M1: "a push received").
  - Android push is B2.
- ~~**iOS `StoragePaths.maxBytes` = 50MB vs a 120MB doc/UploadService comment**~~ **fixed
  (ios-m0-readiness PR):** one 500 MB cap in the api and the app (see "one upload cap" above).
- **A6.5 needs brand sign-off:** final accent hue, logo/wordmark artwork, and typeface are `TODO(brand)`;
  the palette is a provisional, accessible v1. Full light-mode wiring across the (dark-first) UI is a follow-up.
- **iOS broadcast extension — wire or exclude before submission (A6.6 N1).** It's bundled but no in-app UI
  triggers it and its only permission copy is mic-only; App Review will question an unexplained
  system-capture extension. Decide before the iOS submission build: **wire it** (RPSystemBroadcastPickerView
  + honest capture copy + the A4 App Group) **or exclude it** from that build. Needs the A4 App Group either
  way. Default applied: left re-homed in the repo, unwired.
- **A6.4 onboarding deliverables still to BUILD** (audit only so far): permission *explainer* + Settings
  deep-link on denial, and a **sample note** (missing on both platforms — the biggest named gap). Web Home
  has no first-run/empty state; iOS notes-listener failure is silent (`NotesRepository.swift:74`). See
  `docs/audits/A6.4-STATES-AUDIT.md` punch list.

## Found by the backend integration harness (PR-08, 2026-09-24) — fix next

First run of all 13 migrations on a real Postgres 16 + pgvector: **clean + idempotent**. The harness
(`tests/integration/**`, `npm run test:integration`) then surfaced these; each is pinned by a test
where testable so the fix PR proves itself:

- [x] **Fixed (tenant-isolation PR):** **Membership escalation in `markReady`** (`packages/db/src/notes-repo.ts` `upsertCoreToPostgres`):
      it inserts `(workspaceId, authorUid)` into `workspace_members` as **`owner`** with
      `ON CONFLICT DO NOTHING`, never checking the author already belongs. A mismatched worker payload
      makes the author an owner of someone else's workspace. Pinned: `tenant-isolation.test.ts`
      (`it.fails`, verified to fail on the escalation itself).
- [x] **Fixed:** **`markReady` inverts the source of truth**: on a Postgres failure it logs, then still marks the
      Firestore note `ready` ("background reconciliation" referenced in the comment does not exist).
      Postgres must win: fail the task so it retries instead.
- [x] **Fixed** (UPDATE scoped by `workspace_id`): **`applyNoteEdit` has no Postgres membership check** — `UPDATE notes WHERE id=$1`; the route
      (`services/api/src/routes/update-note.js`) only checks the Firestore doc's `authorId`.
- [x] **Fixed** (3 sites + checker widened to `=> undefined|null|void 0|…`, now also scans `scripts/`): **Silent catch** `ROLLBACK … .catch(() => undefined)` in `notes-repo.ts`, and
      `scripts/check-no-silent-catch.sh` only matches `() => {}`, so `() => undefined` / `() => null`
      slip through — widen the checker.
- [x] **Fixed** (only `42501` is swallowed): **`scripts/migrate.ts` mislabels failures**: every `CREATE EXTENSION` error (including
      *connection refused*) is printed as "lacks CREATE privilege; expected" — misleading on an
      outage. Only swallow `42501 insufficient_privilege`; rethrow the rest.
- [x] **Also fixed in the same PR:** `markReady` could **overwrite a note in another workspace**
      (`notes ON CONFLICT (id) DO UPDATE` had no workspace guard); `markError` and
      `note-terminal.cjs markNoteFailed` updated `notes WHERE id=$1` without a workspace scope. All three
      are now workspace-scoped, each with a two-workspace test (mutation-checked: they fail on the old code).
- [x] **Also fixed:** `markNoteFailed` mirrored Firestore `'error'` even when Postgres matched no row
      (note already `ready`, or another workspace → phantom doc). Now mirrors only when Postgres marked it
      failed or the Postgres write itself errored. Tested.
- [x] **Pre-existing, found by the auditors (all fixed):**
      - [x] **Fixed (process-queue tenant-boundary PR):** `process-intelligence.js` set note status
        directly in Firestore at **six** sites (185, 197, 268, 272, 289, 317; the audit had listed four).
        It also carried its own Postgres writer with **no workspace guard**: a caller could reset another
        tenant's note, re-point it at their own audio and delete its `audio_chunks`, because Postgres note
        ids are global while Firestore's are per-workspace. This was reproduced on Postgres. All of it now
        goes through `notesRepo.markQueued` / `markError`, and the route is off the checker's allowlist.
        Also fixed there: callers with no email claim (anonymous sign-in) got a 500 on every
        `/v1/process`, because `users.email` is NOT NULL.
      - [x] **Fixed (idempotent-kickoff PR):** a Postgres pre-check (before rate limits and metering) answers
        a duplicate with 202 and the current status, and a foreign id with 404. `markQueued` re-checks
        atomically (per-note advisory lock + `FOR UPDATE`), so concurrent duplicates queue once. Anything
        in flight longer than 3 h counts as stuck and may re-queue, until the PR-15 sweeper replaces that.
        ~~Residual: two duplicates can both pass the pre-check within milliseconds, and if the loser then
        fails the size or rate check, `failNote` marks the winner's note `error`~~ **fixed
        (kickoff-reject-spares-inflight PR):** the two pre-queue refusals go through
        `markKickoffRejected`, which leaves a note in flight alone (Postgres and the doc). The guard is in the
        `UPDATE`'s `WHERE`, so it is re-checked against a duplicate that commits mid-refusal. Tested at the
        repo (including that race) and the route; mutation-checked. Still true: the loser has spent
        rate-limit budget.
        Was: **A duplicate `/v1/process` for an IN-FLIGHT note** (e.g. a client retry after a timeout)
        re-queues it, which resets the running job and deletes its `audio_chunks`. If the duplicate is
        rejected instead (rate limit, too large), it transiently marks the in-flight note `error`; the
        job still finishes `ready`, because workers don't gate on status. This predates the
        tenant-boundary fix. It needs an in-flight guard in the kickoff: a note already `queued` or
        processing returns 202 with the current job, and never resets or errors it. Do it in PR-16
        (idempotent kickoff).
      - [x] **Resolved (idempotent-kickoff PR):** the foreign-id pre-check now runs before metering, so a
        rejected request never reaches `meterMinutes`. The key format is unchanged, because refunds find the
        debit by `note_id`. Was: **Metering idempotency key isn't workspace-scoped** (low): `meterMinutes` uses
        `${noteId}:ingest`, and it runs *before* markQueued's boundary check. A caller presenting another
        tenant's note id is refused, but the meter call has already deduped against (or pre-claimed) that
        tenant's key. No data is exposed, but it's a billing edge. Scope the key by workspace, or run the
        boundary check first, in the metering PR (PR-16).
      - [x] **Fixed (migrate-before-rollout PR):** db-job now uses `logger.child(...)`; the dead
        `backfill-pr-d` dispatch entry (no handler file) is gone. Was: **db-job's logger is always the fallback:** it calls `logger.cjs .forContext(...)`, which doesn't
        exist, so every run uses an ad-hoc stdout logger that writes `level` instead of `severity` (Cloud
        Logging may not treat errors as ERROR) and prints Error objects as `{}`.
      - [x] **Fixed (surface-dropped-errors PR):** the Error instances among these (`cleanupErr`,
        both `rollbackErr`, `parseErr`) are now logged as `err`. (`op.error` is a plain status object,
        and `reason` is a rate-limit string; both serialize fine.) Was: **Errors logged under a key other than `err` lose message + stack** (logger only formats `err`):
        `process-intelligence.js:112`, `transcoder/src/fast-path.js:104`, `summarizer/src/handler.js:238`,
        `transcoder/src/handler.js:132`, `search-and-chat.cjs:499`.
      - [x] **Fixed (surface-dropped-errors PR):** a decode failure is now reported as the operation's
        error (DECODE_FAILED), so the existing terminal path runs: chunk error, note failed, DLQ.
        Tested with a fake operations client and mutation-checked. Was: `services/transcoder/src/stt.js:140`: an STT response decode failure is swallowed and saves an
        empty transcript chunk — must fail the chunk and log.
      - [x] **Fixed (surface-dropped-errors PR):** delete-account logs `delete_account_token_invalid`
        (warn); eval-diarisation treats only ENOENT as "no override"; malformed YouTube captions are
        `YOUTUBE_CAPTIONS_MALFORMED` instead of "no captions". Was: Silent fallbacks: `delete-account.cjs:56` (token verify failure → 401 with no log),
        `db-job/.../eval-diarisation.js:77`, `extractor/.../youtube.js:193`.
      - [x] **Fixed (syntax-aware silent-catch PR):** `scripts/check-no-silent-catch.mjs` parses server and
        shared code with the TypeScript compiler. A catch must throw, log, use the error, or carry
        `// silent-catch-ok: <reason>`. 12 server sites were triaged (2 fixed, 10 marked with a reason).
      - [x] **Fixed (web-silent-catches PR):** the 17 unreadable-body reads go through
        `apps/web/src/lib/http.ts` (`readErrorText`/`readErrorJson`, which log a warning). The 12 catch
        clauses now log, or carry a reasoned `silent-catch-ok` (mostly `localStorage` being unavailable in
        private mode). `apps/web/src` is in the AST gate's roots. Was: **apps/web/src silent catches (27):** mostly `resp.text().catch(() => '')`, plus
        `catch { /* ignore */ }`. They're still under the old one-line grep rules. Clean them up (a shared
        `readErrorBody(resp)` helper plus reasoned markers), then add `apps/web/src` to the AST gate's ROOTS.
      - Was: Checker gaps: `catch (e) {}` with a non-underscore name, comment-only catches, multi-line catches.
        Replace the grep checker with a small syntax-aware Node check + an explicit allow marker.
- [x] **Fixed (pg-connection-config PR):** **One Postgres connection config.** `packages/db/src/db.ts` (api/billing/notifier repo layer)
      connects **without SSL**, while the transcoder/summarizer/embedder pools force
      `ssl:{rejectUnauthorized:false}` because Cloud SQL once rejected unencrypted VPC-connector traffic
      (embedder "Bug 16"). Terraform does not set `ssl_mode`. Unify into one pool-config builder, set
      `ssl_mode` explicitly in Terraform, and add a deep health check that proves each service can
      query Postgres after deploy — before the first staging deploy relies on it.
- [x] **Done:** `check-no-console.sh` already scans `packages/db` + `packages/ai`; its stale `db.ts`
      allowlist entry is removed (db.ts moved to the structured logger in #15). Was: **`db.ts` used `console.error`** (fixed here → structured logger); `check-no-console.sh` should
      also scan `packages/db` + `packages/ai` — widen it.
- [x] **Reconciled (#44 + the contract part-2 PR):** 28 operations documented, 0 spec-only, and the only
  router-only route left is `POST /v1/process-audio`, which is retired rather than documented (PR-16). Was:
  **Contract drift**: only 4 api routes match `openapi.v1.json`; 7 spec paths are served under
      other names and 24 routes are undocumented. Pinned by the ratchet `tests/contract-routes.test.ts`
      (fails on any new drift). Reconcile to zero before the iOS `/v1` client (plan PR-17).

## Found while patching dependency advisories (2026-09-24) — queued

- [x] **Fixed (web-build-tesseract PR):** the plugin resolves each package with `createRequire` (npm hoists
  them to the root). The two native plugin wrappers the extraction never brought over
  (`src/plugins/BackgroundRecorder`, `BroadcastRecorder`) are now typed web shims, like the rest of
  `native-shim`: they refuse every call, and App.tsx only calls them when the platform isn't web. A
  `web-build` CI job builds it on every PR. Was: **The web build is broken under the workspace install (pre-existing).**
  `apps/web/vite.config.ts`'s `copy-tesseract-assets` plugin copies from
  `apps/web/node_modules/tesseract.js…`, but npm hoists `tesseract.js` and
  `tesseract.js-core` to the repo-root `node_modules`. `npm run build -w apps/web`
  therefore fails with ENOENT on `worker.min.js`. Both the old and the new lockfile
  hoist them, so this predates the vitest bump. CI never builds the web app, which
  is why nobody saw it. Fix: resolve each file with
  `createRequire(import.meta.url).resolve('tesseract.js/dist/worker.min.js')`, and so
  on, instead of a fixed relative path; then add a `web build` job to CI.
- [ ] **Dependabot alert #5, `uuid < 11.1.1`: owner decision.** It only reaches us
  through Google's client libraries (gaxios, google-gax, teeny-request,
  googleapis-common), which pin `uuid@^9`. Their only calls are `uuid.v4()` with no
  arguments, and the advisory needs `v3`/`v5`/`v6` called with a `buf`, so the
  vulnerable path is unreachable. Proposed: dismiss it as "vulnerable code not
  actually used" (your call: it changes alert state), and let Google's own bump
  retire it. Don't force-override `uuid` under their libraries.

## Dependency triage: planned upgrades (2026-09-24)

These were held back from Dependabot (`.github/dependabot.yml` `ignore`) because they are migrations, not bumps:

- [ ] **Node 24 → 26 (base images + `engines`).** Node 26 enters LTS around late
  October 2026. Move all 8 service images together, run the boot smoke plus a staging
  deploy, and update `engines`. Never move to an odd major: Dependabot proposed
  `node:25`, which is already EOL (#20, declined).
- [x] **Done (web-vite-8 PR):** vite 8.3, `@vitejs/plugin-react` 6.1 and `@tailwindcss/vite` 4.3. The build
  passes (and the `web-build` CI job keeps it so). `vite.config.ts` uses `import.meta.dirname`, ready for
  vite's native config loader. Was: **Web toolchain: vite 6 → 8 plus `@vitejs/plugin-react` 6** (#30 declined; plugin-react 6
  requires vite ^8). Do it in one apps/web PR, together with the tesseract-asset build
  fix above and a web-build CI job, so the result is actually verified.
- [x] **Resolved by removal (retire-process-audio PR):** the synchronous `/v1/process-audio` route and
  the `@google/genai` dependency are gone. Was: **`@google/genai` 1 → 2** (#29 declined): its only user is
  `services/api/src/routes/process-audio.js`, the synchronous route plan PR-16 retires.
  Delete the dependency with that route; don't migrate it.
- [x] ~~**Three Dependabot majors held open, because nothing tests the code they change**~~ **merged
  (#52, #107, #108), each after a test around its call site; two of the tests caught a real break first**
  (below). Kept for the record:
  - **#52 `stripe` 17 → 22** (`services/billing/src/lib/stripe.js`, used by `routes/portal.js` and
    `webhooks/stripe.js`). Every Stripe major pins a newer API version, which changes object shapes. It's the
    web rail; M1 is StoreKit. **Test in place (billing-stripe-tests PR):** `tests/integration/billing-stripe.test.ts`
    runs checkout, the portal and the webhook through the real SDK against a local stand-in for
    api.stripe.com (`STRIPE_API_HOST`, unset when deployed). It pins the request paths and form fields, the
    `Stripe-Version: 2024-06-20` our shapes depend on, the subscription and invoice fields the webhook reads,
    and signature checking. Next: rebase #52 so its CI runs this on v22.
  - **#108 `googleapis` 144 → 181** (`services/billing/src/lib/google-play.js` `verifyPlaySubscription`,
    used by `routes/verify.js` and `webhooks/google.js`). The Android rail is Track B. **Test in place
    (billing-google-play-tests PR):** `tests/integration/billing-google-play.test.ts` runs it through the real
    `androidpublisher` v3 client against a local stand-in (`PLAY_API_ROOT_URL`, unset when deployed, with a
    static token so no credential is looked up). It pins the request path, the bearer header and the fields
    read back, checks that a Play error is thrown, and checks that the verify route grants Pro until Play's
    expiry. On v181 the test caught `pub.purchases.subscriptions.get is not a function`: Google is retiring
    v1 `purchases.subscriptions`, and v181 drops it. `verifyPlaySubscription` now uses `subscriptionsv2.get`
    (play-subscriptionsv2 PR), which v144 has too. The expiry comes from the product's line item, or the
    latest-expiring one after a plan change. Then rebase #108.
  - **#107 `pdfjs-dist` 4 → 6** (`services/extractor/src/extractors/pdf.js`,
    `apps/web/src/lib/documentText.ts`). Two majors, with changes to the module and worker setup.
    `web-build` only proves the web bundle builds. **Test in place (extractor-pdf-test PR):**
    `tests/extractor-pdf.test.ts` runs the extractor through the real pdfjs-dist on a two-page PDF built at
    test time. It pins each page's text, in order, with no OCR, and checks that a non-PDF is rejected. The
    web's `documentText.ts` stays covered by `web-build` only; the web is moving to the extractor. On v6
    the test caught `pdf.destroy is not a function` (and `web-build` the same in `documentText.ts`): pdf.js 5
    removed `PDFDocumentProxy.destroy()`. Both now call `loadingTask.destroy()`, which works on 4 and 6
    (pdfjs-destroy PR). Then rebase #107.
- [ ] **Express 4 → 5** (all 7 services, #24 declined for now). It brings native
  async error handling (the `wrap()` adapters go away) but changes path syntax
  (named wildcards), `req.query`, and removes APIs. Do it as one PR per service
  group, with the route-contract ratchet and the boot smoke as the safety net.

## Model lifecycle (PR-10, 2026-09-24): queued

- [ ] **Verify gemini-3.5-flash on staging before relying on it.** The first staging
  deploy runs `vertex-smoke`, which is the real test. It checks that, with the
  summarizer's schema and 16,384-token budget on a ~40-minute transcript, 3.5-flash
  finishes with `STOP` rather than `MAX_TOKENS` (thinking counts against the
  budget). If it truncates, raise `maxOutputTokens` or set a thinking budget, and
  keep the smoke as the gate. **Hard deadline: 2026-10-20**, when 2.5-flash
  retires and 3.5-flash is the only rung.
- [x] **Done (vertex-smoke-audio PR): the smoke also sends the fast path's call.** Each ladder rung
  gets inline audio (a 2-second synthetic WAV tone, generated at runtime, no user data) with the fast
  path's schema and budget. The deploy fails before rollout if a rung rejects audio, truncates, or answers
  off-schema. Still to verify on staging: a real short recording end to end (the M1 proof).
  Was: **Transcoder fast path sends audio inline to Gemini** and `vertex-smoke` only exercised text.
- [ ] **Embedding migration before 2027-04-01:** `text-embedding-004` → `gemini-embedding-001`
  (served in Sydney; set `outputDimensionality: 768` to keep `vector(768)`). Vectors
  from different models don't compare, so: ~~add `embeddings.model` to every query~~ **done
  (search-filters-embedding-model PR: `/v1/search`, chat retrieval and eval-recall rank only rows of the
  query's model)**, then re-embed all rows with a db-job backfill, then switch `EMBED_MODEL`. The
  tripwire in `tests/models.test.ts` fires around mid-February 2027 as a backstop.
- [ ] **Newer models (3.6/3.7/3.8-flash, flash-lite) are not served in Sydney.** If
  quality or cost needs them, that's a data-residency decision for the owner.

## Found while documenting the API contract (2026-09-25)

- [x] **Fixed (upload-sessions PR): SSRF and a cross-workspace oracle in `/v1/uploads/{id}`.** The
  `uploadId` was client-controlled base64 JSON holding the GCS session URI and storage path. `GET` then
  PUT to whatever URI it contained, and `/complete` reported whether *any* object existed. Sessions now
  live server-side (migration 013). The id is a random UUID, reads are scoped to the owner's uid and
  expiry, and the stored URI must be `https://storage.googleapis.com`.
- [x] **Fixed (regenerate-via-repo PR):** regenerate-summary's claim, release and mirror now go
  through notes-repo (`claimSummaryRegeneration` / `releaseSummaryClaim` / `mirrorSummarizing`), and
  the release is now workspace-scoped. `check-no-direct-firestore` is syntax-aware. Since then,
  process-audio was retired (#51) and the summarizer's final write moved to `markSummaryReady`, so the
  only allowlisted writers are the repo layer, the terminal-failure writer and the transcoder mirror. Was:
  **`regenerate-summary.js:146` writes Firestore directly**.
- [x] **Fixed (entitlement-contract PR):** the shaper now sends `state` and `trialEndsAt` (the resolver
  already computed `state`). A contract test parses the live body for every state (brand-new, trialing,
  active, free floor). Was: **`EntitlementResponse` requires `state`, but `/v1/entitlement` (and `/v1/process`'s 402) never
  send it,** nor `trialEndsAt`. Live bodies fail `EntitlementResponse.parse`. This is a three-client
  contract change: decide whether the handler adds them or the schema drops them.
- [x] **Fixed (validate-with-contract-schemas PR):** all four now `safeParse` with their published
  schemas (integration-tested against Postgres). Support still trims to 4000 characters, and its schema
  now says so instead of rejecting long messages. Was: **Four handlers ignore stricter schemas that already exist:**
  - accept-terms (only checks truthiness);
  - retention (accepts a missing field);
  - events (accepts any event name, when the `AnalyticsEvent` enum exists);
  - support (truncates instead of rejecting).

  Validate with the schemas in the contract-documentation PR.
- [x] **Fixed (sweeper PR):** expired upload sessions are deleted by the sweep. Was: **Upload sessions
  accumulate:** expired rows were never deleted.
- [x] **Fixed (generation-at-write PR):** `markSummaryReady` takes the generation the run read and
  only writes if it's still current (`summary_generation = $3` in the workspace-scoped UPDATE). A superseded
  run writes nothing in either store, logs `summarizer_generation_superseded`, and doesn't notify. Tested,
  and mutation-checked. Was: **The summarizer's generation guard is checked before Gemini, not at the
  write** (found by the dual-write audit of the summarizer-via-repo PR). The run read `summary_generation`,
  spent minutes in Gemini, then wrote without re-checking it, so an older run could land over a regenerate
  claimed in that window.
- [x] **Fixed (transcoder-sql-into-repo + shared-writers-into-repo PRs): every Postgres write is in the
  repo layer, and CI gates it.** The transcoder's SQL (the chunk gates, status writes, and
  the fast path's whole result in one transaction) lives in `packages/db/src/pipeline-repo.cjs`. The shared
  writers moved whole from `packages/ai` into `packages/db` (`note-terminal.cjs`, `note-edit.cjs`,
  `share-links.cjs`, `note-feedback.cjs`), and the embedder's transcript read and embeddings write moved to
  `packages/db/src/embeddings-repo.cjs` (chunking, the Vertex call and the constants stay in
  `@algominutes/ai/embeddings.cjs`). The gate `scripts/check-no-direct-pg-writes.mjs` (invariants workflow,
  syntax-aware, unit-tested) fails on any Postgres write, to **any** table, outside `packages/db`, with no
  exceptions left: it catches aliases, literal concatenation, interpolated table names and schema-quoted
  names, and ignores prose. On the old code it reported 19. Mutation-checked: a raw `DELETE FROM
  embeddings` put back in `packages/ai` fails the gate, and dropping the workspace filter from the moved
  transcript read fails its integration test. Still open, from the transcoder audit (below): two
  transcoder *reads* outside the repo. Was: **Postgres note writes still bypass the repo layer** (found by the dual-write audit of the
  generation-at-write PR; `check-no-direct-firestore` only sees Firestore, so nothing gates these):
  - `services/transcoder/src/fast-path.js:71-101`: the short-audio path writes transcript lines, the
    summary, action items and key decisions inline. It has no generation guard, and it sets status
    through `transcoder/src/db.js upsertNoteStatus`, which is `UPDATE notes … WHERE id = $1`, with no
    workspace scope and no `deleted_at` check. A task for a deleted note (or a mismatched payload)
    still updates it. (Also `startMs = intelligence.MODEL_LADDER && …` is a no-op guard; harmless while
    the ladder is exported, fragile if it moves.)
  - `services/transcoder/src/db.js` (chunks; its status write is now workspace-scoped, see the
    workers-note-gone PR), `packages/ai/src/note-edit.cjs:104-131`
    (manual edits), `packages/ai/src/embeddings.cjs:137-142`, and ~~`functions/index.js:117`~~ (retired)
    (`workspace_id = COALESCE($2, workspace_id)`: a null workspace matches any note).
  - Fix with PR-12 (the transcoder rewrite): move the transcoder's writes into notes-repo with
    workspace-scoped, `deleted_at`-aware SQL, and route the fast-path's final write through
    `markSummaryReady`. Then add a Postgres counterpart to the gate (writes to `notes` / `summaries` /
    `action_items` / `key_decisions` / `transcript_lines` outside `packages/db`).
- [x] **Fixed (pipeline-reads-into-repo PR):** the failure tail's author lookup, in both the transcoder's
  and the summarizer's `terminal-hooks.js`, read the note by id alone, so a task naming another workspace
  resolved *this* note's author, who would then be notified (CLAUDE.md §1 multi-tenancy). The transcoder's
  chunk-progress read was unscoped too. Both are now `pipeline-repo.cjs` reads: `noteAuthor` is scoped to the
  task's workspace when it has one, and `chunkProgress` to the workspace and a live note. Tested with two
  workspaces for both services; each filter mutation-checked. Other raw *reads* remain in services (the api
  routes' membership-joined queries, the summarizer's scoped transcript read, db-job diagnostics); the write
  gate doesn't cover reads. Was: **Two transcoder Postgres reads are outside the repo layer** (from the
  transcoder-sql-into-repo audit; the dual-write audit of #115 found the summarizer's copy).
- [x] **Fixed (firestore-gate-batch-writes PR):** the gate now also flags a write whose *first argument*
  is a document ref (`batch.delete(db.doc(p))`, `tx.set(noteRef, …)`, bulk writes), a bare `ref`
  receiver (the old `/Ref$/` missed it; `share-links` relied on that), and `snap.ref.update(…)`.
  Deliberate non-note writes carry a reasoned `// firestore-write-ok: <reason>` on the line or the line
  above. The two rate-limit counters are marked. The account-deletion cascade is marked as a tracked
  exception (below). Was: **The direct-Firestore gate misses batched and transactional writes.**
- [x] **Done for M1 (note-deletion-path, account-deletion-path, workers-note-gone, ios-delete-via-v1,
  deleted-note-tombstone PRs):** a note is deleted through `POST /v1/notes/delete` (iOS since #114),
  Postgres first, then the doc, then the audio, and a tombstone keeps a stale client from uploading into
  it. Account deletion is one idempotent Postgres-first path. Open below, not on the M1 path: the web
  client's `setDoc` merge writes (R2, the web `/v1` migration), and shared workspaces on account deletion.
  Was: **⚠️ M1: deletion doesn't work on the new backend. A deleted note stays in Postgres, stays
  searchable, and its audio stays in GCS.** (Verified 2026-09-25.)
  - **Deleting a note:** the clients delete the Firestore doc (`NotesRepository.swift deleteNote`) and rely
    on the `functions/` trigger `onNoteDeleted` to delete the Postgres rows and GCS audio. Nothing in the
    new pipeline deploys `functions/`: no workflow, Terraform or runbook references it, and it targets
    `us-central1`. Nothing writes `notes.deleted_at` either. So the transcript, summary and embeddings stay,
    and `/v1/search` and chat still return them (they filter on `deleted_at IS NULL`, which is never set).
  - **Deleting an account** (`delete-account.cjs`): `DELETE FROM users` cascades almost every table, so the
    Postgres side works *if every step succeeds*. But each step is best-effort: a failure is logged, then
    Auth is deleted anyway and the request returns 200, so the user can never retry. GCS audio is removed
    only by that undeployed trigger. Non-note Firestore docs (`rateLimits/{uid}`) are never removed.
  - **Done (note-deletion-path PR):** `POST /v1/notes/delete` → notes-repo `deleteNote`. The author or a
    workspace owner/admin may delete. The note's upload sessions go in the same transaction. The purge also
    re-deletes the mirror doc, so a crash between the commit and the doc delete can't leave it behind. A
    client-supplied `storage_path` is honoured only if it's exactly this note's object name.
    - Postgres goes first, in one workspace-scoped transaction: a membership check, then the cascade.
      Search and chat can no longer return the note.
    - Then the Firestore mirror.
    - Then the audio purge. It's recorded in `storage_purges` (migration 014) in the same transaction and
      matched by exact object name, so deleting `note1` never touches `note10`, which the old
      `onNoteDeleted` prefix sweep would have. A failed purge stays queued.
    - Idempotent, and tested (integration + route, mutation-checked).
  - **Still open for M1:**
    - [x] iOS calls the route instead of deleting the doc (iOS PR-17 C), and the Firestore rules stop
      clients deleting note docs (firestore-rules PR).
    - [x] **Fixed (workers-note-gone PR): workers no longer resurrect a deleted note.**
      - Every transcoder mirror helper, plus `markSummaryReady`, `mirrorSummarizing` and `note-terminal`,
        now uses `update()`, which fails on a missing doc. A Firestore NOT_FOUND there means the note
        is gone.
      - The transcoder kickoff checks Postgres (workspace-scoped) before its first write. Any vanished-note
        signal (NOT_FOUND, NOTE_NOT_FOUND, FK 23503) acknowledges the task: no retry, no error mirror, no
        DLQ, no push. `markSummaryReady` answers `not_found`, so there's no "ready" push.
      - The embedder reads the transcript scoped to the task's workspace and acknowledges a vanished note.
        Before, a mismatched task could index one workspace's words under another's `workspace_id`.
      - `transcoder/src/db.js upsertNoteStatus` is now workspace-scoped and `deleted_at`-aware.
      - Tested, and mutation-checked.
    - [ ] **Found by the dual-write audit of the workers-note-gone PR (pre-existing, queued):**
      - ~~**R1:** `markQueued` can bring back a note deleted between the api's doc check and its own
        transaction~~ **fixed (markqueued-deleted-note PR):**
        - `deleteNote` takes the kickoff's per-note lock, so the two serialise.
        - With no row, `markQueued` refuses if a purge row exists, or once purged, if the doc is missing.
          This check runs before any row lock, so the Firestore read holds only the note lock.
        - The mirror is `update()`. On its NOT_FOUND, `markQueued` asks Postgres: the row gone means
          deleted (the route answers 404 and enqueues nothing); a live row means a legacy client deleted the
          doc, so it throws and the route fails the note instead of leaving it `queued`.
        - Tested with a real concurrent kickoff and delete; each part mutation-checked.
        - **Your call (billing policy):** a note deleted in the milliseconds after its kickoff commits keeps
          its ingest debit, and nothing can refund it afterwards (`usage_ledger.note_id` is SET NULL on
          delete). If that should be refunded, `deleteNote` would write the reversal in its own transaction
          for a note still `queued`.
      - **R2:** the web client's `setDoc(…, { merge: true })` writes (`apps/web/src/lib/noteStatus.ts:4`,
        `App.tsx`) can re-create a doc deleted from another device. That's fixed by the web's `/v1`
        migration.
      - **R3:** ~~a YouTube permanent failure mirrors `error` to Firestore only~~ **fixed
        (youtube-permanent-failure PR):** it now calls `noteTerminal.markNoteFailed`, Postgres first, so a
        retry isn't refused for 3 h. ~~Still open: `chunking` and `summarizing` are mirrored with no matching
        Postgres status write~~ **fixed (status-mirror-follows-postgres PR):** the kickoff writes `chunking`
        to Postgres (workspace-scoped, deleted-aware) before mirroring it, and the completion gate writes
        `summarizing` before the mirror and the summarizer enqueue. Tested for order and mutation-checked.
    - [x] **Fixed (note-delete-cancels-upload PR):** `deleteNote` records the note's open GCS upload-session
      URIs on its purge row (migration 017, expand-only), and the purge cancels them *before* it deletes the
      doc and objects. An upload that finished first is removed with the objects, a finished or expired
      session counts as cancelled. A failed cancel doesn't hold up the delete: the doc and objects still go,
      and the row keeps only the failed URI for the sweeper's retry, which cancels it and deletes the objects
      again. The cancel follows no redirects and gives up after 10 s. Tested and mutation-checked. Was: a
      client still holding a session URI could finish uploading after the delete.
      - [ ] **Verify on staging:** the status codes GCS returns to DELETE on a *finished*, a cancelled and an
        expired resumable session. The code accepts 499/404/410/200/204; anything else leaves the purge row
        retrying (the audio is deleted anyway). Put the real codes in `note-delete.test.ts`.
      - [x] **Fixed (upload-refuses-deleted-note PR):** an upload session minted *during* a deletion
        used to miss its purge. `createUploadSession` now takes the note lock first (the order the kickoff
        and `deleteNote` use) and refuses a note with a pending purge. The route cancels the session it just
        minted and answers 404. Tested at the repo and the route; mutation-checked.
      - [x] **Fixed (deleted-note-tombstone PR):** `deleteNote` and account deletion now write a
        `deleted_notes` tombstone (migration 018, ids only) in their transaction. `createUploadSession` and
        the kickoff refuse a note with a pending purge *or* a tombstone, so a stale client can't upload into
        a note whose purge finished, and a doc re-written by a stale web client (R2) can't re-queue it. The
        sweeper prunes tombstones after 30 days (DATA-RETENTION.md). After that, a months-stale client
        could still upload an object, and only the optional `recordings_lifecycle_days` rule removes it.
        Tested (upload, kickoff, account deletion, sweep); four mutations checked. Was: a session for a
        note whose purge already *finished* (no purge row left) was allowed, and its object stayed in the
        bucket.
        - [x] **Fixed (ios-deleted-note-recording PR), found by the audit of that PR:** `recoverRecording` /
          `resumePendingUploads` re-uploaded a saved recording into its original note id without checking
          the note still existed, and deleting a note didn't remove its saved recording. The server refuses
          that id for 30 days, so the app retried into a 404 on every foreground.
          - Deleting a note in the app (`AppEnvironment.deleteNote`, all three delete buttons) now removes
            its waiting recording once the server has confirmed the delete.
          - A note deleted elsewhere makes `POST /v1/uploads` answer 404, now `UploadError.noteGone`. The
            recording is then kept as a new note: `associate()` replaces the sidecar, and the old session
            with it.
          - A first upload whose note was deleted mid-way is left alone, with no error mark or alert.
          - Tested (XCTest): the 404 mapping, removal per note, and the re-association forgetting the old
            session. The whole app type-checks against the Firebase stubs. The `AppEnvironment` flows
            themselves need Firebase, so they are checked on device (M1).
    - [x] The sweeper drains `storage_purges` (#71; capped at 10 attempts), and a stuck row is logged every run
      and alerts (`storage_purge_stuck`, #90).
    - [x] **Done (account-deletion-path PR):** account deletion uses this path. Postgres goes first, in
      one transaction: a purge row per owned note, tagged with the uid (migration 015), then
      `DELETE FROM users`, whose cascade removes the rest. Then the purges (each note's doc and audio),
      the account's workspace docs, `rateLimits/{uid}`, and leftover uploads under its workspace
      prefixes. Auth goes last. A Postgres or Firestore failure answers 500 with Auth intact, so the
      client retries, and the retry finishes the job by uid. Hardened after its dual-write audit:
      - an `account_deletions` tombstone (migration 016) keeps the owned workspace ids for retries, and
        makes `ensureUser` refuse to re-create the account from a still-valid token. The upload route
        refuses (401) before minting a GCS session;
      - the transaction locks the user and workspace rows, so a concurrent note insert fails its FK
        instead of escaping a purge;
      - dead letters, support requests and analytics events go too (their FKs only NULLed the uid);
      - workspace docs are deleted with their subcollections (`recursiveDelete`), which catches note docs
        that never reached Postgres, along with the root `analytics` docs;
      - ANY failure after Postgres answers 500 with Auth intact, because no sweeper exists yet.
      - after its second audit: the tombstone check runs AFTER `ensureUser`'s upsert, so a write racing the
        deletion can't re-create the account (tested with a real two-connection race). `authMiddleware`
        refuses a tombstoned uid on every route. `markQueued` takes the user row before the note row (the
        order deletion uses), so there's no deadlock. Open GCS upload sessions are cancelled, with retries,
        via the tombstone. Purges left in the account's workspaces by earlier note deletions run too.
    - [ ] Residuals, queued:
      - ~~Bucket versioning keeps "deleted" audio~~ **fixed (purge-all-object-versions PR):** the purges
        delete every generation, and a noncurrent-version lifecycle rule (7 days) is in Terraform, pending
        your apply. See DECISIONS.
      - ~~Alert on `delete_account_incomplete` and on `storage_purges.attempts >= N` (PR-16c)~~ **done
        (alerting-silent-failures PR, pending your apply):** `alerting.tf` has log-based counters and email
        alerts for `storage_purge_stuck`, `delete_account_incomplete`, `sweep_step_failed`,
        `dead_letter_recorded`, `note_failed` (>2 in 30 min), `gemini_model_unavailable`, and the api/billing
        losing Postgres, plus an api/billing 5xx-rate alert. Set `TF_VAR_alert_emails` at plan time. The rest
        of PR-16c (dashboard, uptime check, SLO doc, e2e workflow) is still open.
      - ~~Single-note deletion should also cancel the note's open upload session~~ **done
        (note-delete-cancels-upload PR)**: see the item above.
      - Before shared workspaces ship, account deletion must transfer or refuse a shared workspace. Today
        an owned workspace goes with its owner, members' notes included.
      - The api's `verifyIdToken` doesn't check revocation. The tombstone blocks the write paths that could
        re-create the account, but a deleted account's token can still *read* (nothing is left) for up to
        an hour. Clients must sign out on the 200.
      - ~~Firestore rules (PR-11)~~ **done (firestore-rules PR, pending your apply):** rules in the repo,
        released by Terraform, emulator-tested in CI. Clients can't delete notes. They can still re-create
        their own `workspaces/{ws}` doc after an account deletion (the sign-in bootstrap), but the api refuses
        the account (tombstone), and the doc holds nothing. Before the rules, staging denied every client request.
      - ~~The sweeper should prune tombstones and drain `storage_purges`~~ **done (sweeper PR):**
        a dedicated `db-sweep` Cloud Run Job (the db-job image with `JOB_NAME=sweep` baked in, its own
        least-privilege SA), run by Cloud Scheduler every 15 min (Terraform, pending your apply). It:
        - retries purges, capped at 10 attempts; stuck ones are listed apart, so they never crowd out
          newer ones;
        - fails notes stuck in flight past `IN_FLIGHT_STALE_MS` + 30 min. `failStuckNote` re-checks at the
          UPDATE, and the dead letter and refund happen only on a match;
        - drops expired upload sessions;
        - **finishes account deletions a client abandoned**;
        - prunes tombstones completed more than 30 days ago.

        An advisory lock stops runs overlapping.
      - Found by the sweeper's audit (pre-existing): `run-api` had no Firebase Auth grant, so account
        deletion's Auth step would have failed in every deployed environment. Both the api and the sweep now
        get a custom role with only `firebaseauth.users.delete`.
      - ~~`process-intelligence.js` also writes root Firestore `analytics` docs~~ **fixed
        (analytics-to-postgres PR):** it was the only server-side writer (`process_queued`). The event isn't
        in the contract's `AnalyticsEvent` funnel, and the `kickoff_enqueued` log line already carries every
        field, so the write is gone rather than moved. Account deletion still sweeps legacy docs.
    - [x] **Done (retire-functions PR):** `functions/` is gone (its only export was `onNoteDeleted`, never
      deployed, with an unsafe prefix sweep), along with the workspace and `firebase-functions` in the
      lockfile. Deletion is `POST /v1/notes/delete` → `deleteNote` → `storage_purges`, and nothing else.
  - **Fix (plan PR-34, moved ahead of M1):** one deletion path in the repo layer, used by both:
    - `DELETE /v1/notes/{id}` (an additive contract change; iOS moves to it in PR-17): a workspace-scoped
      Postgres delete in one transaction, then the Firestore mirror, then a Cloud Task (idempotent, with a
      DLQ) that deletes the note's GCS prefixes.
    - Account deletion: Postgres first; answer 200 only when Postgres is gone; Auth last; each step
      idempotent so a retry finishes the job.
    - Firestore rules stop clients deleting note docs directly (after PR-17).
    - Integration tests: no row with the uid or note id survives, and search can't return a deleted note.
- [x] **Fixed (trace-across-task-hops PR): traceId did not cross the Cloud Tasks hops** (found by the log
  auditor of the generation-at-write PR). `enqueueTask` sent only the payload, and every worker made a
  fresh traceId from its own request header, so one recording logged under a different id in each service.
  This broke the CLAUDE.md §1 invariant and the M1 evidence item "one `traceId` end to end". Now
  `enqueueTask` requires a traceId and writes it into the task body. Every worker logs under
  `traceIdFromTask(body, headers)` (validated; falls back to the header). A syntax-aware test fails if any
  `enqueueTask({...})` call omits it. `traceIdFrom` now only takes a well-formed header id (with or
  without a span), so a malformed header can never make a strict enqueue fail a kickoff. The summarizer's
  lines, and every notify line, also gain `userId`; the worker loggers gain `workspaceId`.
- [x] **Resolved (retire-functions PR): the trigger is gone.** The deletion path runs in the api and its purge row
  carries the request's `trace_id`. Was: **The note-delete cascade hop has no traceId.** `functions/index.js onNoteDeleted` is a Firestore
  trigger, so there's nowhere to carry the api's id. It gets fixed with plan PR-34 (the single deletion
  path): the api enqueues the cascade as a Cloud Task, which carries the id like every other hop.
- [x] **Fixed (uid-across-task-hops PR):** the api's kickoff and regenerate tasks carry the caller's `uid`.
  The transcoder passes it on every hop (self, summarize, embed), and the transcoder, summarizer and embedder
  loggers bind it as `userId`. Was: **Workers can't log `userId`: no task payload carries `uid`.** The api has `req.uid` at kickoff, so
  add `uid` to the kickoff payload, and have the transcoder pass it on to the summarize and embed payloads.
  Then the transcoder, embedder and summarizer entry loggers can bind it. (Task payloads are internal and
  aren't in `packages/contracts`.) Small; queued.
- [x] **Tested (summarizer-skips-onready PR):** the real summarizer handler, on Postgres with a fake Gemini
  ladder, writes nothing and skips `onReady` (the "ready" push) when a regenerate is claimed, or the note is
  deleted, during its Gemini call. Mutation-checked. Was: **No test covers the summarizer skipping
  `onReady` when `markSummaryReady` wrote nothing.**
- [x] **Fixed (pg-connection-budget PR; owner chose "cap the pools"):** a per-environment budget
  (`connection-budget.json` → max instances + `PG_POOL_MAX`), enforced by a Terraform precondition, a test,
  and a CI run with every pool capped at 1. See DECISIONS. Was: **Postgres connections vs `db-f1-micro` (staging).** That tier allows about 25 connections. Each
  service's pools are lazy, and real use is bounded by request concurrency (the summarizer holds at most one
  repo connection per request: 4 instances × concurrency 4 = 16). But the sum across services at max scale
  is well over 25: api alone is 4 instances × (api-read 10 + repo 8). At low traffic this is fine. Under a
  burst it fails with "remaining connection slots are reserved". Decide before external TestFlight: give
  each service a connection budget (pool max × max instances ≤ the tier's limit), or move to a larger tier
  (a cost decision, yours). The staging proof should watch `pg_stat_activity` under the e2e run.

## Found in the CodeQL backlog (2026-09-25)

- [x] **Fixed (billing-apple-fail-closed PR): Apple purchases and notifications were trusted without
  verification** (CodeQL `js/user-controlled-bypass`, high). `lib/apple.js verifyAndDecodeJws` only decoded
  the JWS. So any signed-in user could forge a StoreKit transaction to `POST /v1/purchases/verify` and grant
  themselves Pro with any expiry, and anyone could forge App Store notifications (renew or revoke a real
  subscriber). It now **fails closed with 503**. Only `APPLE_JWS_TRUST_UNVERIFIED=true` restores decode-only,
  for local dev and tests, and never on Cloud Run (`K_SERVICE`). The Google Play rail was already safe: it
  re-verifies every token server-side against the Play API.
  - [ ] **PR-32 (before any Apple billing):** verify the x5c chain to Apple Root CA - G3, the ES256
    signature, and the bundle id / environment. The paywall stays hidden behind its flag until then.
- [x] **CodeQL backlog triaged** (only #63 remains, owned by PR-32):
  - ~~`js/polynomial-redos` in `redaction.cjs` (#22)~~ and ~~`js/incomplete-multi-character-sanitization`
    in the YouTube extractor (#24)~~: **fixed** (CodeQL closed both on 2026-09-24). Only **#63**
    (`js/user-controlled-bypass`, Apple JWS) is open, and PR-32 closes it;
  - ~~`js/log-injection` in `client-error.js` (#62)~~ **fixed (client-error-log-sanitiser PR):** the
    flattening already removed every line break, but CodeQL only recognises a global replace of `"\n"`
    with `""` (its `StringReplaceSanitizer`), so that no-op step now ends the chain. The alert stayed
    open: numeric values were logged raw (a second, unsanitised flow). They are dropped now
    (client-error-strings-only PR); no capped field is numeric;
  - ~~`js/insecure-helmet-configuration` ×2~~ **fixed (strict-csp PR):** both JSON services send
    `default-src 'none'` instead of disabling CSP (DECISIONS);
  - ~~`js/missing-rate-limiting` ×6 on billing~~ **fixed (billing-rate-limits PR):** billing uses the
    shared limiter (`@algominutes/ai/rate-limit.cjs`): per client IP on everything but health (the store
    webhooks included), per uid after auth. Its `trust proxy` is the hop count, not `true`. Its auth also
    refuses a deleted account, as the api's does;
  - ~~`js/missing-rate-limiting` ×27 on the api (#87–#113, opened by the billing-rate-limits PR)~~
    **fixed (api-limiter-visible-to-codeql PR):** that PR made the api's `middleware/rate-limit.js` a
    destructured re-export of the shared module, which CodeQL can't follow to the express-rate-limit call,
    so every `/v1` route looked unlimited. They never were: the client-IP limit covers `/v1` and `authed`
    carries the per-uid one. The api now imports the shared module directly, as billing does, and the shim
    is gone;
  - ~~`actions/missing-workflow-permissions` ×7 and `actions/unpinned-tag` ×14~~ **fixed
    (harden-workflows PR):** every workflow has a least-privilege top-level `permissions` block
    (`promotion-guard` has none), and the six third-party actions are pinned to commit SHAs with
    version comments. Dependabot (`github-actions`) keeps them current.

## Found while fixing R1 (2026-09-25)

- [x] **Fixed (kickoff-meter-in-queue-tx PR): every first `/v1/process` answered 500.** Nothing had ever run
  the route against real Postgres. The kickoff debited the ingest minutes (`meterMinutes`) *before*
  `markQueued` created the note row, and `usage_ledger.note_id` is a foreign key, so the first kickoff of
  every note failed with `meter_ingest_failed` (FK 23503). A new user whose first action is a YouTube import
  failed one step earlier: `ensureTrial` inserts `subscriptions`, and `subscriptions.uid` references a
  `users` row that nothing had created yet. Now `markQueued` writes the debit in the queue transaction,
  after the note row, and only when it actually queues (a duplicate or refused kickoff debits nothing).
  `ensureTrial` creates the user row in its own transaction. `tests/integration/process-kickoff.test.ts`
  runs the real route against Postgres, faking only Firestore, GCS, Cloud Tasks and the rate-limit
  counter. It is mutation-checked.
- [ ] Residuals (pre-existing, found by the dual-write audit of that PR):
  - Three failures after `markQueued` commits mark the note `error`, but its ingest debit stands:
    - the Firestore mirror write fails;
    - the transcoder config is missing (`kickoff_misconfigured`);
    - the Cloud Task enqueue fails.

    A retry isn't charged again (the key is idempotent), but a user who gives up has paid for nothing.
    The sweeper refunds only in-flight notes. Refund on these paths, or enqueue through an outbox written
    with the debit.

    **Fixed by #166 for all three (checked 2026-09-26):** each path goes through `failNote`, whose
    `markError` carries the refund (`refund:enqueue_failed`, net-guarded) in its transaction. A failed
    mirror write throws out of `markQueued` after its commit and reaches `failNote` too
    (`process-intelligence.js`, the `mark_queued_failed`, `kickoff_misconfig` and `enqueue` events).
    - [ ] Only the enqueue failure has a Postgres test (`process-kickoff.test.ts`). Tests for the mirror
      failure and the misconfigured kickoff land with the metering PR (plan S2-PR6c).
  - ~~After a refund, a re-queue of the same note reuses the `${noteId}:ingest` key, so the re-run is
    free~~ **fixed (metering-per-run PR):** one debit per run. `markQueued`, under the note's lock, charges
    the note only when its net is 0 (never charged, or its last run refunded); a failure that wasn't
    refunded keeps its charge, and the retry isn't charged twice. Refund keys are suffixed with the debit
    they reverse, so a second failed run is refunded too: the per-note key had silently refused it.
    Tested on Postgres (two failed runs; an unrefunded failure; a replayed refund; a deleted note's key
    met again, now logged `meter_debit_key_taken`); four mutations checked.
    - [ ] **Deploy order (from its audit):** a new api with old workers charges a re-run and then refuses its
      refund (old per-note refund key). Staging deploys all three together today (`fail-fast: false`, so a
      failed rollout can leave the mix: re-run the failed service). **Production: roll out the transcoder and
      summarizer before the api** (PR-35 runbook).
    - [x] ~~A kickoff racing a refund makes the re-run free~~ and ~~two refunds for the same run with
      different reasons can both land~~ **fixed (refund-in-failure-tx PR):** every refund is written in the
      failure's own transaction (`markNoteFailed` / `failStuckNote` with `refund`, one reversal SQL in
      `ledger-reversal.cjs`), under the note's row lock. `markQueued` locks the same row, so a kickoff sees
      the failure and its refund together; a second refunder waits, then finds the net at 0. Where no
      retry is left (a worker's last attempt), a refund that can't be written falls back to the failure
      alone (`*_refund_lost`), so the two stores agree.
      - [ ] **Queued (from its review, pre-existing):**
        - ~~The api's `failNote` → `markError` after `markQueued` has debited doesn't refund~~ **fixed
          (enqueue-failure-refunds PR):** `markError` takes a `refund`, written in its transaction, and the
          kickoff's failures after the debit pass one (`refund:enqueue_failed`).
        - The sweep refunds a stuck regeneration (`summarizing`) with `refund:stuck`, against the
          regeneration rule.
        - A failure can deadlock with account deletion (note row, then the ledger's foreign key on
          `users`, against `users` then the cascade); Postgres picks the failure, which retries or, on a
          last attempt, falls back as above. The note is being deleted anyway.
        - `reverseUsageForNote` is still exported and takes no lock (only tests call it); a partial unique
          index on `reverses_id` would enforce one reversal per debit.
    - [ ] `assertCanMeter` demands headroom for a retry that won't be charged (its earlier charge stands),
      so a user at their limit gets a 402 on that retry.
  - The quota check (`assertCanMeter`) runs outside the queue transaction, so two concurrent kickoffs of
    different notes can both pass it.

- [x] **Fixed (admit-new-users PR): a new user's onboarding failed before their first recording.** Only
  `/v1/uploads` and `/v1/process` created the `users` row, but a new user's first requests are onboarding.
  `terms_acceptance`, `push_tokens`, `analytics_events` and `support_requests` all have a `users` foreign
  key, so accept-terms, push registration, events and support failed with 23503 (reproduced), and
  `setRetentionDays` saved nothing. Both auth middlewares now **admit** the caller (`admitUser`): the first
  time an instance sees a uid, it upserts the row from the token's claims and checks the tombstone in one
  transaction, then for 10 minutes does only the tombstone read the middleware always did.
  - Found by its dual-write audit and reproduced: deleting an account that had **no** `users` row locked
    nothing, so a first request racing the deletion could insert a row that outlived it. The same gap already
    existed through uploads and the kickoff. `deleteAccountData` now inserts a placeholder row before
    locking it, so the racer is either deleted or rolled back. Regression test with a real uncommitted
    insert; mutation-checked.

## Long recordings: chapters and salvage (plan rev 8, PR-13a, 2026-09-25)

- [x] **Done (summary-chapters PR): a long recording's summary has chapters, and a cut-off answer is salvaged.**
  - The summarizer asks for chapters past 10 minutes: its own prompt part, so every template's prompt is
    unchanged, and a schema with `chapters` ordered last.
  - `summary-output.cjs` validates each chapter's start against the recording, sorts them, keeps one per
    start and caps at 40. Chapters are scrubbed for PII like the rest of the output, stored in
    `summaries.chapters` (migration 020), mirrored to `summary.chapters`, and returned by `/v1/notes/read`.
    The contract gains `Chapter`.
  - A cut-off answer is repaired to its last complete value, so the gist, action items and decisions land
    (`summary_salvaged_partial`) instead of the note failing.
  - Found on the way: `NoteReadMeta.title` is nullable in fact (the kickoff sets no title), and is now so
    in the contract. iOS decodes only the transcript from that response, so nothing broke on device.
  - Tested (unit, the handler on Postgres, the read route against the contract); six mutations checked.
  - **Map-reduce judged unnecessary:** a 4 h transcript is about 40-60k tokens, inside Gemini flash's
    input window, and the output (chapters included) fits 16,384 tokens. Recheck with a real 3 h note on
    staging (M1).
  - **From its PII audit, fixed in the same PR:** chapters are scrubbed whole and *then* trimmed. Trimming
    first could cut a card number or an email into a fragment the patterns no longer match, which was then
    stored. The salvage error no longer quotes the model's output, since it reaches logs and the dead letter.
  - [x] **Fixed (pii-parse-errors-speaker-names PR), pre-existing, from that audit and the PR's own:**
    - the fast path's `parseGeminiJson` and the older `parseSummaryJson` put Node's JSON error (about
      10 characters of model output) in their message. They now say `INVALID_JSON: unparseable model
      output (N chars)`, like the salvage, and still map to the friendly error;
    - chat's `chat_stream_parse_failed` warning logged the first 80 characters of a cut-off stream event
      (about 15 of them the answer) and Node's message. It now logs the error's name and the length;
    - the fast path stored the model's speaker labels unscrubbed (in `transcript_lines.text` and the
      Firestore preview), and it hears raw audio, so a label can be something said aloud.
      `redactTranscriptLines` now scrubs a string `speaker` too. Every later reader already scrubbed
      the whole stored line, so this was storage only;
    - the summarizer now scrubs `transcript_lines.speaker_name` too. That column holds the model's
      labels on rows the retired `markReady` writer stored. The names users type live in
      `note_speakers.display_name`, which nothing sends to Gemini; the summarizer's comment says to
      scrub them the same way if that changes.
    - Tested (unit tests for both parsers, the label scrub and the chat parse; the summarizer on Postgres
      for the prompt); five mutations checked.
  - [x] **Removed (remove-debug-corpus PR), pre-existing, from that PR's audit:** the db-job
    `debug-corpus` handler, a dev leftover (its defaults were `algominutes-dev` and us-central1). Its
    "global" query had no workspace filter and logged the first 80 characters of the top chunks, with
    note titles, from any workspace, so an operator run on staging or prod would have copied users'
    meeting text into Cloud Logging. `eval-recall` stays: it is scoped to the e2e test workspace.
  - [x] ~~**iOS renders chapters (PR-13b)**~~ **done (#128):** the summary lists a long recording's chapters,
    and a tap plays from there. An edit keeps them (#161).
## Long recordings: the transcoder on replay (plan rev 8, PR-12, 2026-09-25)

- [x] **Fixed (transcoder-resumable-chunks PR): a replayed kickoff re-paid for speech it had already bought.**
  A kickoff Cloud Tasks retried (after a crash or a timeout) restarted a Google speech job for every chunk,
  finished ones included, and each restart added a second poll chain. The result was still correct
  (the line writes and the completion gates are idempotent), but the audio was billed twice.
  - The chunk row is written first. A chunk that is done is skipped. A chunk whose job already runs
    isn't started again, only re-polled. The whole-file (AssemblyAI) path does the same.
  - Poll tasks carry a deterministic id (`<chunkId>-stt-poll-<n>`). `enqueueTask` treats `ALREADY_EXISTS`
    as done, so duplicate chains collapse into one.
  - A replay only resumes a note still `queued`, `chunking` or `transcribing`. One that moved on is
    acknowledged, not dragged back to `transcribing`, where the sweeper would later fail it.
  - An unreadable duration is a permanent failure (note marked, terminal tail, no retry), and
    `routeForDuration` never defaults an unknown length to the fast path.
  - Tested on Postgres and in unit tests; six mutations checked.
  - **Fan-out not needed, measured:** a 4 h recording (113 MB AAC) probes in 53 ms and extracts its 24 FLAC
    chunks (543 MB) in 5.4 s on the dev Mac. Even at 5× on Cloud Run's 2 vCPU, plus the in-region
    transfer, the serial kickoff is minutes against Cloud Tasks' 30-minute dispatch deadline. Recheck on
    staging with a real 3 h upload (M1).
  - **From its dual-write audit, fixed in the same PR:**
    - Every kickoff status write is conditional on the note still being in progress, not just the first.
      An attempt that stalls past its dispatch deadline (30 min, against the transcoder's 60) can wake
      after its replay finished the note.
    - A poll on a chunk whose run already failed stops.
    - A replay that finds a failed chunk re-marks the note failed instead of re-polling.
    - A replay mirrors the progress Postgres holds.
    - ffprobe or ffmpeg failing to *run* (not spawnable, or killed) is retried, not reported as a damaged
      recording.
- [x] **Fixed (probe-adts-exact PR): ADTS AAC durations were bitrate guesses.** ADTS has no duration
  header, so ffprobe estimates the length from the bitrate:
  - a 4 h recording read 43 s short, so its end was never transcribed;
  - a 30 s clip that opens with silence read as 223 s.

  This already hit imported `.aac` files, and it matters most for the iOS recorder's crash-safe format
  (PR-22). `probeDuration` now measures ADTS by decoding (4.7 s for 4 h). CI installs ffmpeg so the
  real-binary test runs, rather than skipping.
  - [ ] **Queued (pre-existing, from that audit):**
    - ~~`note-terminal markNoteFailed` never throws when its Postgres write errors, so a terminal path acks
      with Firestore ahead of Postgres~~ **fixed (terminal-failure-retries PR):** every failure a handler
      decides on itself (YouTube, `duration_unreadable`, a chunk already failed, a poll chain run out, a
      speech job that errored, and the summarizer's "no speech") passes `retryOnPgError`. A Postgres error
      then throws before anything is mirrored, and the task retries the decision. (The dual-write audit
      caught the kickoff's catch-all mirroring `Processing failed.` on the way out; that catch-all no longer
      mirrors anything, below.)
      The four poll paths
      mark the note before the chunk, since a chunk already marked `error` makes a retry return early.
      The index.js last-attempt path keeps the old never-throw behaviour. Tested on Postgres with a
      trigger standing in for the outage (six cases, six mutations). Not covered by a test: the
      whole-file (AssemblyAI) poll sites and YouTube, which take the same flag.
      - [ ] **Queued (pre-existing, from that PR's silent-catch audit):**
        - ~~The kickoff's outer catch mirrors `Processing failed.` to Firestore on any other throw~~
          **fixed (kickoff-no-error-mirror PR):** it rethrows and mirrors nothing. Before, until the retry
          wrote `chunking` again, Firestore said failed while Postgres said in progress, and the api
          refused the app's retry as in flight. Now the app shows the note processing (with E2's slow
          notice if it takes long) until the queue's last attempt marks both stores through
          `markNoteFailed`. `mirrorError`, which had no other caller, is gone. A mutation re-adding the
          mirror fails three tests.
          - **From its dual-write audit, fixed in the same PR:** the fast path can commit `ready` to
            Postgres and then fail to mirror it. Its retry found the note finished and acked, so the doc
            stayed at `chunking`: an endless spinner with no Try again. Before, it showed a wrong `error`.
            A first fix repaired the doc from Postgres on that replay; its re-audit showed the repair was
            itself racy. It could restore action items the user had since edited, overwrite a
            regenerated summary, and refund a ready note if the repair kept failing. So it was reverted.
            Now the fast path logs a failed mirror after its commit (`fast_path_ready_mirror_failed`)
            instead of throwing. Throwing bought nothing and skipped the embedder, so the note was never
            searchable. The doc stays behind Postgres until the sweep step below exists. Tested on
            Postgres; two mutations checked.
          - [ ] **Queued (pre-existing, from those audits):**
            - ~~**A sweep step that re-mirrors recently finished notes.**~~ **Done (sweep-mirror-repair PR):**
              the sweep's `mirror_repair` step (`packages/db` `mirror-repair.ts`) checks notes Postgres finished
              10-40 minutes ago. It reads the doc first, then Postgres in one snapshot, and writes only if
              Postgres says finished, the doc disagrees, and the doc hasn't changed since its read (an
              update-time precondition). Repairing to `ready` writes the summary and transcript from Postgres,
              as `markSummaryReady` does (the doc can hold an earlier run's), with the transcript redacted
              across lines like the summarizer's preview. A doc written in the last 10 minutes is left alone,
              because the clients' Retry writes `queued` there before Postgres moves. It covers the fast
              path's failed mirror after its commit, a last attempt's lost `error` mirror, and any other lost
              mirror write. Tested on Postgres with a precondition-honouring fake (13 cases); seven mutations
              checked.
              - [ ] **Queued (from its audit):** a run lists at most 200 notes, oldest first, and warns
                (`mirror_repair_limit_reached`) when it hits that; past it, newer notes can age out of the
                window unchecked (page by `(updated_at, id)` or keep a watermark). The listing uses
                `notes_status_idx`, which doesn't narrow `ready`/`error`; a partial index on `updated_at` for
                finished notes (new migration) would stop it scanning every finished note. Whether Firestore
                answers a precondition write to a deleted doc with 9 or 5 is unconfirmed; both are handled.
                The repaired lists share the `created_at, id` ordering item below.
            - When the fast path's or a completion's embedder enqueue throws after its claim, the claim is
              spent and the note is never embedded.
            - `/v1/notes/read` orders action items and decisions by `created_at, id`. The rows share one
              transaction's `created_at`, and `id` is a random UUID, so the order is random. iOS reads
              the summary from Firestore, so it isn't affected. Fix: store a position.
            - ~~**Every** `completeChunkAndAdvance` caller commits `summarizing` and spends the summarizer
              claim, then mirrors, then enqueues; a mirror that throws in between left the summarizer
              unqueued~~ **fixed (pipeline-no-lost-work-after-commit PR):** a failed mirror after that
              commit is logged (`chunk_complete_mirror_failed`), and the summarizer and embedder are still
              queued. The mirror still goes first, so a quick summarizer's `ready` can't be overwritten by
              a late `summarizing`. From that PR's audit, also fixed there:
              - The gate itself was five or six autocommits, so an error part-way left the chunk done
                with the gate unfinished, and the retry returned early. It is now one transaction
                (`completeChunkGate`): a failure rolls the chunk back and the retry runs it all. Two
                chunks completing at once still give exactly one completion (tested).
              - A summarizer enqueue that threw also dropped the embedder. Both are now tried, and the
                first failure is logged (`chunk_complete_enqueue_failed`) and rethrown.

              Still lost: an enqueue that itself throws after its claim (the 3.5 h sweep fails the note).
              A sweep that re-drives a `summarizing` note with a full transcript would cover it.
            - ~~`persistFastPathResult` writes `ready` without a status condition~~ **fixed (same PR):** it
              commits only over an in-progress note, so a duplicate delivery gets `NOTE_MOVED_ON` (acked)
              instead of overwriting the finished note and the user's edits since.
              - Tested on Postgres (eight cases); five mutations checked.
            - ~~The workers' last-attempt path runs the refund, dead letter and "note failed" notice even
              when `markNoteFailed` matched nothing~~ **fixed (final-attempt-hooks PR):** every terminal
              path (each worker's last attempt, the transcoder's four poll terminals, its two kickoff
              failures) follows one rule. `markNoteFailed` reads the status it replaces under
              `FOR NO KEY UPDATE` and returns `marked` (Postgres has the note at `error`) and `failed`
              (this write moved it there). The refund keys on `marked`: `reverseUsageForNote` is
              net-guarded, so a second chunk, a retry or an earlier refund leaves it a no-op. The "failed" notice keys on
              `failed`, so the author is told once. A note that is ready anyway gets the dead letter alone
              (the one record of lost work, such as an embedder enqueue after the commit), as does one
              Postgres couldn't be asked about; one that is gone gets nothing. A poll's chunk is marked
              `error` in the note's statement and only with it, so a retry after a Postgres error finds
              neither written; a poll that finds its chunk already failed re-runs the mirror and the tail
              while the note is still failed (so a poll terminal that died after its commit is refunded on
              its retry), and leaves a note that has moved on (a regeneration) alone.
              A failed note keeps its first message. A failed existence probe no longer mirrors `error`
              onto a ready note. `note_failed` (the alert's line) fires only for a new failure or a
              Postgres error. Tested on Postgres (both workers' last attempts; 13 poll cases, one holding
              the note's lock; the ledger through the real hooks); mutations checked.
              - [ ] **Queued (from its re-reviews):**
                - ~~**A crash after the commit loses the refund**~~ **fixed (refund-in-failure-tx PR):** the
                  refund commits with the failure on every path. What a crash after the commit still loses
                  outside the poll terminals (the kickoff's YouTube and unreadable-length failures, the
                  spend cap, each worker's last attempt) is the dead letter. (~~and the notice~~: the
                  notices outbox, below.)
                - ~~**A failed regeneration refunds the whole recording**~~ **fixed
                  (regeneration-failure-keeps-charge PR):** the summarizer's last attempt refunds only a
                  pipeline summary's failure; a regeneration's (its task carries `summaryGeneration`) is
                  failed and told, and the recording's charge stands. Tested on the ledger through the real
                  hooks; two mutations checked.
                - ~~`markNoteFailed` with a chunk locks note then chunk, against `completeChunkGate`'s chunk
                  then note~~ **fixed (poll-failure-locks-chunk-first PR):** every writer now takes the note,
                  then its chunks (`completeChunkGate` gained a note lock; `markQueued`, `deleteNote` and
                  account deletion already did), so none of them deadlock with a poll's verdict.
                - When Postgres errors, the mirror writes the caller's message while Postgres keeps the
                  first; mirror repair compares status only, so they don't converge.
                - A re-drive's dead letter says `chunk_already_failed`, not the original reason.
                - ~~A crash between the commit and the notice loses the push~~ **fixed (notices-outbox PR,
                  migration 022):** the transaction that makes a note ready or failed writes its notice
                  (`note_notices`, one per note, run, summary generation and kind), and enqueues it after the
                  commit as a task named after the notice. The notifier claims the notice before sending and
                  marks it sent, so a replayed or duplicated task sends nothing; the sweep re-enqueues a
                  notice still unsent after 5 minutes (under its recording's traceId) and gives up after a
                  day, logged `notice_abandoned`. Tested on Postgres (`note-notices.test.ts`: a crash after
                  the commit, a duplicate and a concurrent delivery, a failed send, a deleted note, a re-run,
                  a regeneration); 13 mutations checked. Found on the way and fixed with it: the fast path
                  (every recording under 10 minutes) never sent a "ready" push at all.
                - A re-driven poll records its dead letter again (the dedupe item below).
                - ~~A poll from a run that was just re-queued can fail the new run~~ and ~~a second poll
                  chain can turn a `done` chunk into `error`~~ **fixed (poll-failure-locks-chunk-first
                  PR):** a poll's verdict locks the note, then its chunk; a chunk that's gone (re-queued,
                  even while the verdict waited on the note) or `done` makes it moot (`superseded`): nothing
                  is failed, refunded or told. And a late completion of a failed (or finished) note's chunk
                  is refused (`completeChunkGate` returns `finished`), so it can't move the note on to
                  `summarizing` after its refund and "failed" notice. Tested with the re-queue locking the
                  note first and deleting the chunks while the verdict waits; mutations checked.
                - ~~A poll task's last attempt (`last-attempt.js`) passes no `chunkId`, and its dead letter
                  drops the chunk, job and reason~~ **fixed (poll-last-attempt-keeps-chunk PR):** its chunk
                  fails with the note (a well-formed id only), and the dead letter keeps the chunk, job and
                  poll count.
                - ~~The summarizer's "No speech was found" failure has no notice, and the sweep's
                  `refund:stuck` path never notifies~~ **fixed (notices-outbox PR):** both write their
                  "failed" notice with the failure (`markNoteFailed`, `failStuckNote`). No dead letter for
                  "no speech", on purpose: nothing was lost, the recording had no words, and the notice
                  tells the user so.
            - ~~The web watchdog (`App.tsx`) still writes `error` straight to Firestore from the browser
              while Postgres may be in flight~~ **fixed (web-watchdog-reports-slow PR):** as on iOS
              (#124), a note the server owns is reported slow ("Taking longer than usual"), never
              failed from the browser; the sweep fails a stuck run, Postgres first. Only the client's own
              `processing` note (before the kickoff, so no server run exists) is still failed once its
              upload goes quiet. `lib/noteWatchdog.ts`, unit-tested; one mutation checked.
            - ~~`persistFastPathResult` doesn't reset `summaries.chapters`, and `applyNoteEdit` replaces the
              whole Firestore `summary` map, which drops `summary.chapters`~~ **fixed (edit-keeps-chapters
              PR):** an edit mirrors by field path, so a long recording keeps its chapters (and a
              Firestore-only key-points list) when an action item is edited; the fast path clears an
              earlier run's chapters in both stores. Tested on Postgres; three mutations checked.
        - ~~The spend guard's catch in both `index.js` files rethrows a non-cap error without logging
          it~~ **fixed (spend-cap-reader PR):** `haltAtSpendCap` logs `spend_guard_failed` and answers 500.
        - ~~If the note write lands but `markChunkError` then fails, the retry logs a second `note_failed`
          (the alert counts it)~~ **fixed (final-attempt-hooks PR):** one statement writes both. If the
          speech job finishes before an exhausted poll's retry, that retry completes the chunk and the note can go on to `ready`, with no refund or failure
          notice sent. That's a good outcome, but the two stores briefly disagree.
        - If Postgres stays down through every attempt of a poll failure, the last attempt's dead letter
          carries the Postgres error and the request body, not `stt_operation_errored` / `stt_poll_exhausted`
          and the chunk id. The user sees the generic "We could not process this recording."
    - Inline (Deepgram) mode records no operation id, so a replay re-transcribes. Deepgram is off
      (`STT_PROVIDER=google`).
    - A crash between `markChunkDone` and the summarizer claim leaves the note to the stuck-note sweep.
    - A kickoff of a note's previous run can continue into a re-queued note. Checking the kickoff's
      `jobId` needs `markQueued` to store it.

## Uploads finish without the app (plan rev 8, PR-24, 2026-09-25)

- [x] **Done in code (ios-uploads-finish-in-background PR):** uploads went in 8 MB chunked PUTs from an async
  loop, so a suspended or killed app finished the chunk in flight and nothing more. A 3-hour recording
  waited until the user opened the app again.
  - The rest of a file now goes as one background PUT: the file itself from byte 0, or a copy of its tail
    (in Caches) when resuming. The system's upload daemon finishes it without the app.
  - A failure asks the server how far it got and sends the rest.
  - Found on the way: on a background relaunch the session was never recreated (it's lazy), so the system's
    queued events never arrived and its completion handler was never called. The AppDelegate now reconnects
    it.
  - A transfer that finished while the app was away re-runs the resume path (session complete, then the
    kickoff) under a background task.
  - A transfer still running from an earlier launch is joined, never duplicated.
  - Tested (XCTest): the final range, and the tail copy, byte for byte, across several copy slices. The app
    type-checks under strict concurrency against the stubs.
- [ ] **Verify on device (M1):**
  - record 10+ minutes, stop, lock the phone at once: the note should finish processing without the app
    being opened;
  - force-quit is different: iOS cancels a force-quit app's background transfers, so the next launch
    resumes it.

## Observability (plan rev 8, PR-16c, 2026-09-25)

- [x] **Done (observability-uptime-dashboard PR, pending your apply):**
  - **Uptime check** on `GET /v1/health` every 5 min from several regions. It pages when it fails from
    more than one region for 10 min.
  - **Dashboard** *algominutes-&lt;env&gt;: pipeline*: api requests, api latency p95, worker requests, queue
    depth, failed notes, dead letters, Cloud SQL CPU and connections. Its JSON was validated by the
    Monitoring API in validate-only mode, before your apply.
  - **Error Reporting now receives errors.** An error line carries a top-level `stack_trace`; nested
    under `err`, none were ever reported.
  - **`docs/SLO.md`**: six objectives, each with its signal and alert.
- [ ] **The e2e workflow** (a custom-token test user; a 10-minute fixture nightly, a 3-hour one weekly;
  fixtures in GCS): needs staging up.
- [ ] **Check on staging (from the logger audit):**
  - that Error Reporting groups errors whose message spans lines (ffmpeg stderr, Vertex error bodies);
  - that it reads entries from the Cloud Run *job* (db-job);
  - Error Reporting's retention against the 30-day promise.

## Brand leftovers (plan rev 8, PR-21, 2026-09-25)

- [x] **Done (ios-brand-leftovers PR):**
  - The `Owll*` design-system names from the client era are now `AlgoMinutesCard`, `AlgoMinutesCardStyle`
    and `AlgoMinutesBackground` (18 files), and the "Owll-style" comments are gone.
  - The Rajdhani brand fonts are removed: three TTFs, their `UIAppFonts` entries, the test asserting they
    were registered, `scripts/fetch-fonts.sh`, and the no-op `Theme.assertBrandFontsLoaded()`. Typography
    already used the system font, so nothing rendered differently.
  - The launch screen was already in place (`UILaunchScreen` with the `LaunchBackground` colour).
- [ ] **Check at the M0 upload:** the primary 1024 icon and its dark variant have no alpha channel. The
  tinted variant does. App Store validation checks the primary icon; if the upload refuses the tinted
  one, flatten it (`scripts/generate-app-icon.swift`).
- [ ] **Brand sign-off (yours, A6.5):** the final palette and a typeface. The app runs on the provisional
  indigo palette and the system font.

## Account deletion revokes Sign in with Apple (plan rev 8, PR-29 M1 part, 2026-09-25)

- [x] **Done in code (ios-apple-revocation PR):** deleting an Apple-linked account first asks the user to
  confirm with Apple, then revokes its tokens (`Auth.revokeToken(withAuthorizationCode:)`), then deletes.
  Apple requires this (App Review 5.1.1(v)).
  - A dismissed prompt stops the deletion, with an explanation.
  - A failed revocation doesn't block deletion (logged `apple_token_revoke_failed`): removing the data
    comes first.
  - Accounts without Apple sign-in, including anonymous ones, are unaffected.
- [ ] **Yours:** configure the Firebase Apple provider (Services ID, Key ID, `.p8`) in `algominutes-staging`.
  Without it the revocation fails and is logged.
- [ ] **Verify on a real iPhone (M1):** delete an Apple-linked test account, and the app disappears from
  Settings → Apple ID → Sign in with Apple.

## Broadcast capture of another app (plan rev 8, PR-25, 2026-09-25)

- [x] **Done in code (ios-broadcast-capture PR): the app can capture another app's call and make it a note.**
  - After the same consent step, *Capture audio from another app* shows the system broadcast picker,
    preset to the AlgoMinutes extension, with the microphone on. It goes through `CaptureKind.appAudio` on
    the same gate.
  - When the app returns to the foreground it claims the finished capture once, mixes the extension's
    two tracks (app audio and microphone) into the one track the transcoder hears (verified: both
    halves audible after the mix), and uploads it like a recording.
  - A capture whose extension died (stale heartbeat) is reported, and its unreadable partial is removed.
- [ ] **Verify on a real iPhone (M1):** a FaceTime or Zoom call captured, and both sides in the transcript.
- [ ] **Before App Store submission:** a server-side kill switch for broadcast (the top App Review risk),
  and review notes that explain the feature.
  - [x] **Server side (api-broadcast-kill-switch PR):** `GET /v1/config` answers `{ broadcastCapture }`
    (contract `AppConfigResponse`); `BROADCAST_CAPTURE=off` on the api turns it off, anything else leaves it
    on. To flip it, add the variable to the api's env in `infra/terraform/modules/environment/cloud-run.tf`
    (one line, then plan and apply); it isn't wired yet, to keep the saved staging plan current.
  - [ ] **iOS:** read `/v1/config` at launch and on foreground, and hide *Capture audio from another app*
    when it's off (keep the last answer; hidden until the first one).
- [ ] **Queued:** the extension writes `.m4a` with AVAssetWriter, so if iOS kills it (a 50 MB memory
  limit) mid-capture, the capture is lost. AVAudioFile can write ADTS, but the two sources run on
  different clocks. Measure how often it happens before redesigning.

## Spend cap (plan rev 8, PR-15, 2026-09-25)

- [x] **Done (spend-cap-reader PR, the env var pending your apply):** the §4.6 daily cap was inert, because
  its reader returned 0. It now reads the audio minutes the transcoder sent to paid work in the last
  24 hours times `COGS_AUD_PER_MINUTE` (default A$0.03), cached for a minute.
  - The minutes come from `usage_events`, which the transcoder now writes as each speech job, whole-file
    job or fast-path Gemini call starts, with the duration it measured itself. The first version read
    the ledger debits. Its second audit showed imports are debited 0 minutes (the client sends no
    duration), and a note retried after a refund is never debited again. So the ledger missed real
    spend.
  - At the cap, a kickoff whose note is still `queued` is failed, Postgres first, with "We've reached today's
    processing limit". Only on that transition is it refunded (`refund:spend_cap`), dead-lettered and its
    author told, and the task acknowledged. Before, the task was dropped and the note stayed in progress
    until the sweep.
  - A replay mid-run, a note that moved on, a poll task and the summarizer aren't stopped: their speech
    is already paid for (DECISIONS "Spend cap").
  - Found on the way: staging read as `production` (Cloud Run's `NODE_ENV`) and would have had prod's
    A$200 cap. `ALGOMINUTES_ENV` is now set from `var.env`, which needs a re-plan.
  - Tested:
    - the gate as a unit;
    - the reader on Postgres;
    - the recording at every paid step, including that a replay adds nothing;
    - the transcoder gate on Postgres, including the real refund hook, replays, and each in-progress status.

    Mutations checked for each. See DECISIONS "Spend cap".
  - **From its two dual-write audits, fixed in the same PR:**
    - The hooks ran even when the gate failed nothing, and it failed notes past `queued`, including
      summarizing and regenerating ones.
    - A hook's throw went unhandled.
    - The halt was logged for kickoffs that carried on.
    - A latent blind Firestore mirror existed with `onlyIfStatus`.
    - The runbook still described the old `deferred` answer.
  - **From the third audit (the paid-work reader), fixed in the same PR:**
    - Deepgram's inline call wasn't recorded.
    - The fast path recorded before calling Gemini, so an outage's retries would have tripped the cap
      with nothing billed. It now records once an answer comes back.
    - A speech job is recorded before its op id is saved, so a crash can't leave a paid job uncounted.
    - A note deleted before the insert no longer loses the row: its id becomes null.
    - Migration 021 indexes `created_at`.
- [ ] **Yours / A11:** replace the default rate with the measured blended cost per minute (speech + Gemini +
  storage), as `COGS_AUD_PER_MINUTE`. Also raise `DAILY_SPEND_CAP_AUD` on staging on heavy test days
  (M1 run plus the weekly 3 h e2e is about 360 of the ~660 minutes a day). Verify the trip on staging
  (runbook `gcp-provisioning.md`, spend circuit breaker).
- [ ] **Queued:**
  - The api doesn't refuse a kickoff at the cap: the transcoder fails and refunds it.
  - The embedder, chat and the summarizer's Gemini call aren't metered or gated. They are cents next to
    speech.
  - ~~Nothing deletes `usage_events` rows~~ **fixed (sweep-usage-events-retention PR):** the sweep's
    `usage_events` step keeps 90 days (DATA-RETENTION).
  - **Billing (pre-existing, found by the same audit):**
    - Imports are debited 0 minutes against the user's quota, because the client sends no duration. Meter
      from the transcoder's probed duration.
    - ~~A note retried after a refund reuses its `${noteId}:ingest` key, so the rerun is free~~ **fixed
      (metering-per-run PR)**, with the refund keys.
    - ~~The workers' last-attempt path runs the refund and notice even when `markNoteFailed` matched
      nothing~~ **fixed (final-attempt-hooks PR).**
    - The dead-letter insert isn't deduplicated. (~~The notify task~~ is, by the notices outbox: one
      notice per outcome, one task per notice, and the notifier sends each once.)

## Embedder: batches and retries (plan rev 8, PR-14, 2026-09-25)

- [x] **Done (embedder-batch-and-retry PR):** the embedder made one Vertex `:predict` call per ~2,000-character
  chunk. That is about 80 sequential calls for a 3-hour transcript, and any 429 or 5xx failed the whole note;
  the task's retry then redid every call. Chunks now go 20 per call, so a 3-hour note is about 4 calls, with
  vectors checked for count and order. A 429, 5xx or dropped connection is retried in place with backoff (up
  to 4 attempts), and a refused request (other 4xx) fails at once. Unit-tested with a fake fetch and token;
  two mutations checked. The M1 check "minute-170 content found by search and chat" depends on this path
  indexing the whole transcript; nothing truncates it.

## From the log-fields audit of 2026-09-25 (queued)

- [x] ~~`services/api/src/routes/search-and-chat.cjs` logs the user's scrubbed search text~~ **fixed
  (search-logs-query-length PR):** `search_ok` and the embed lines carry `queryLen`, never the text. A
  search or chat narrowed to one note binds its `noteId` to the logger (well-formed ids only, so a body
  can't put arbitrary text on every line; the not-found lines no longer echo the raw id). Tested (unit:
  failure, timeout, success; integration: `search_ok`, the bound and the malformed id); two mutations checked.
  - [ ] Unverified: whether a Vertex error body (200 characters, carried on `err` by `embed_query_failed`
    and `chat_stream_failed`) can quote the input back.
- [x] ~~`recordPaidWork` and `completeChunkGate` (`pipeline-repo.cjs`) call `log.error` in their catch without
  checking a logger was passed~~ **fixed (pipeline-repo-log-guard PR):** they, and `persistFastPathResult`'s
  rollback catch, fall back to the shared structured logger. Unit-tested; one mutation checked.

## Long recordings: crash-safe capture (plan rev 8, PR-22, 2026-09-25)

- [x] **Fixed (ios-crash-safe-recording PR, with probe-adts-exact #129 on the server): a killed recording was lost,
  and the recorder stopped at 2 h.**
  - The recorder wrote `.m4a`, whose `moov` atom only `stop()` writes. A crash, a jetsam kill or the phone
    dying (no `willTerminate`) left a file nothing could open, and M1's 3 h meeting passed the 2 h cap.
  - Recordings are now **AAC in ADTS (`.aac`)**, 64 kbps constant bitrate, with a **4 h cap** (about
    120 MB, under the 500 MB upload cap).
  - Measured on a file cut at 60%: ADTS decoded all 72.0 s in ffmpeg, AVAudioFile and AVAsset; the `.m4a`
    opened in none.
  - Gemini (both ladder rungs) transcribes ADTS as it's sent today. The server measures ADTS durations by
    decoding (#129).
  - Recovery finds `.aac` and older `.m4a` recordings, each uploaded as its own type.
  - Segmenting was the plan; ADTS makes it unnecessary: no joins, no hand-off gaps, no change to the
    interruption logic.
  - [ ] **Verify on a real iPhone (M1):** a 3 h locked-screen recording with a call mid-way; force-quit
    mid-recording, relaunch, and the recording is offered and uploads; playback seeks accurately.

- [x] **Done in code (ios-recorder-interruptions PR, plan PR-23):** a long recording now stops and keeps its audio,
  with a message saying why, in two more cases:
  - **The disk runs low mid-recording.** Free space is checked every 30 s. Below 50 MB it stops. Other apps
    can fill the disk after the 250 MB start check.
  - **The system's media services restart.** That invalidates the recorder; the ADTS file is intact up to it.

  Thermal state (serious or critical) is logged only: audio capture is light, and stopping a meeting because
  the phone is warm would lose more than it saves. Tested (XCTest): the storage floor, and the new messages.
  The app type-checks against the stubs.
  - [ ] **Verify on device (M1):** fill the disk during a recording (a large download), and check the stop and
    the kept file.

## Found while adding the audio smoke (2026-09-25)

- [x] **Fixed (workers-drop-gemini-key-gate PR): no note could ever be summarised on a deployed backend.**
  The summarizer and the transcoder's fast path threw `GEMINI_API_KEY not set` before any work. The key is
  a leftover from the public-API days: the ladder (`gemini-call.cjs`) ignores it and calls Vertex AI with
  the service's identity (ADC), and nothing sets it (no Terraform, deploy workflow or runbook). So every
  summary failed, and so did every clip of 10 minutes or less (the fast path, `FAST_PATH_MAX_SEC`). The gates
  and the env plumbing are gone. The fast path's `startMs = intelligence.MODEL_LADDER && …` guard is now
  plain `timeStrToMs`. `tests/integration/workers-vertex-auth.test.ts` runs both with no key; it fails on
  the old code with the exact error.

- [x] **Fixed (admit-personal-workspace PR): a user whose notes never reached Postgres couldn't delete
  them.** `deleteNote` checks workspace membership, and only an upload or a kickoff created it. So a
  scanned-text note, which lives only in Firestore, answered 404 on delete. Admission (the auth middleware's
  `admitUser`) now also ensures the personal workspace and its owner membership. Tested and
  mutation-checked.
- [x] **Done (audio-url-route PR): playback had no `/v1` route.** The iOS player read audio from Firebase's
  default bucket, which the api never writes. `POST /v1/notes/audio-url` returns a 15-minute V4 signed GET,
  only for a member of the note's workspace and only for the note's own object. `run-api` gets Token
  Creator on itself for signing (pending your apply). See DECISIONS. The iOS player switches in PR-17 D.

- [x] **Fixed (embedder-failures-not-silent PR): a failed embedding was acknowledged, never retried.**
  `indexEmbeddings` logged an embedding-call or write failure and returned `chunkCount: 0`, so the embedder
  answered 200. Cloud Tasks never retried, the dead-letter path was unreachable, and the note silently stayed
  out of Search and Chat. It now throws, after rolling back the write: the embedder answers 5xx, the last
  attempt dead-letters (and alerts, #90), and a deleted note's foreign-key error is still acknowledged. A
  vector count that doesn't match the chunks is an error too. Tested on Postgres; mutation-checked.
- [ ] **Xcode Cloud → TestFlight (plan PR-30), repo side done (xcode-cloud-scripts PR).**
  `apps/ios/ci_scripts/ci_post_clone.sh` stamps `CI_BUILD_NUMBER`, writes the plist from the secret
  `GOOGLE_SERVICE_INFO_PLIST_B64`, and generates the project (dry-run tested, including a bad secret failing
  fast). **Yours:** the App Store Connect record, testers and agreements, connecting the repo, and creating
  the "Staging → TestFlight" workflow with the secret: `docs/runbooks/xcode-cloud.md`.

## Staging's first apply and deploy (plan rev 9 debrief, #169, 2026-09-26)

- [x] **Fixed (#169): the saved plan of 2026-09-25 would have failed three ways on its first run.**
  - The apply: `allUsers` invoker bindings are refused by the org's `iam.allowedPolicyMemberDomains`.
    api and billing now skip the invoker check instead (DECISIONS).
  - The api's boot: `ALLOWED_ORIGINS=""` (exit 78). Both roots now set the public site, and a blank
    value fails the plan.
  - Search and chat: `run-api` had no `roles/aiplatform.user`, so both would have answered 403.
  - Guards:
    - `tests/tf-env-contract.test.ts` checks each service's `env-spec.cjs` against the env Terraform gives
      it, with the same `checkEnv` the service runs at boot;
    - `tests/tf-iam-contract.test.ts` checks each role against what the code calls;
    - `scripts/check-tfplan-env.mjs` runs both on a saved plan before an apply. On the old plan it
      reported all five problems.

    18 mutations, each caught.
  - Also:
    - the sweeper's Scheduler job starts paused, and the deploy resumes it after the smoke;
    - `BROADCAST_CAPTURE` and an optional `ADMIN_UIDS` reach the api;
    - `prove-staging.sh` runs the suite at `PG_POOL_MAX=1`.
- [x] **Re-planned:** the one `reviewed-<sha>.tfplan` in `infra/terraform/envs/staging` (93 add, 9 change,
  0 destroy; re-made whenever Terraform changes). `check-tfplan-env.mjs` passes on it (9 services and jobs):
  - `invoker_iam_disabled` is set on api and billing only;
  - `ALLOWED_ORIGINS` is the public site;
  - `run-api` holds `roles/aiplatform.user`;
  - the sweep Scheduler job is paused;
  - both alert channels are present;
  - there are no `allUsers` members.

  The superseded `reviewed-2026-09-25d.tfplan` is deleted.
- [x] **Checked 2026-09-26:** `run.managed.requireInvokerIam` is not enforced at the organization, so
  `invoker_iam_disabled` is allowed (runbook §1).
- [ ] **Yours:** apply that plan (the runbook's "plan is current" check first) and run the first deploy in
  the same sitting (§3), by 2026-10-10.
- [ ] **Yours, after your first sign-in:** re-plan with `TF_VAR_admin_uids` (runbook §5), so the
  dead-letter view answers you.

## Clients still on the legacy `/api/*` surface (2026-09-25)

- [ ] **The web app still calls the pre-`/v1` API** (`/api/process-audio`, `api/entitlement`,
  `api/verify-purchase`, and more). The new `services/api` serves only `/v1/*`, so the web doesn't work
  against the deployed backend (it isn't deployed). **The iOS app moved in full** (A–E below).
  - **iOS (plan PR-17), in five PRs** (scoped 2026-09-25; every api call also lacked the required
    `X-AlgoMinutes-Client` header, so each would get a 400):
    - [x] **A, build config (ios-staging-config PR):** Debug, Staging and Release configurations, each
      with its api and billing origins (`AppConfig.swift`, no hardcoded URL). An `AlgoMinutes-Staging`
      scheme archives Staging. The Google Sign-In scheme is written from the bundled `GoogleService-Info.plist`
      at build time, replacing the old project's 909388484461 client. `algominutes://` is registered.
      Staging and Release fail without the plist, and dSYMs upload for every non-Debug build.
    - [x] **B, the `/v1` client (ios-v1-client PR):** every call sends `X-AlgoMinutes-Client: ios/<version>`
      and goes to its `/v1` route: GET entitlement, upload ids in the path, purchases on billing's own host,
      and the new `deleteNote`. A 426 maps to `APIError.updateRequired`. The kickoff sends `durationSec`
      (the quota meters on it) and no longer sends `retryAttempt`, which isn't in `ProcessRequest`. The
      URLSession and ID-token provider are injectable, and chat uses the injected session. `APIClientTests`
      checks every endpoint's method, host, path, headers and body with a URLProtocol stub. A "please update"
      screen is still to come (E).
    - [x] **C, delete through `POST /v1/notes/delete` (ios-delete-via-v1 PR):** `NotesRepository.deleteNote`
      calls the api (Postgres first, then the doc, then the audio). It hides the note at once and restores it,
      with an alert, if the server refuses. All three delete buttons use it. The auto-retitle goes through
      `/v1/notes/update`, so Postgres (search, chat, the transcript read) gets the title too.
    - [x] **D, uploads and playback through the api (ios-uploads-v1 PR):**
      - every recording and import uploads through `POST /v1/uploads` into the api's recordings bucket, and
        the kickoff sends the storage path the server returns;
      - a recording's sidecar remembers its session, so a retry continues it from the server's byte count.
        The old resumable path resumed a *new* session from an old offset, which GCS rejects;
      - playback asks `POST /v1/notes/audio-url` for a 15-minute signed URL;
      - a scan's source image is no longer uploaded: it went to Firebase's default bucket, which account
        deletion never purged, and the note is its text;
      - `FirebaseStorage` is gone from the app.

      Needs the audio-url backend route (its own PR). Still to do: the server-side `totalBytes` cap on
      `/v1/uploads`, and background (app-suspended) transfer (the PUTs run on a background URLSession, but
      the loop that drives them doesn't survive suspension).
    - [x] **E1, the kickoff's answers (ios-kickoff-answers PR):** `KickoffFailure` maps each `/v1/process`
      refusal to one action, at all three kickoff sites (the first upload, the re-upload, and the retry):
      - a 402 opens the paywall with the entitlement from its body;
      - 413 and 429 show the server's own message and leave the note alone (the server already marked it
        failed, Postgres first);
      - a 404, a network error or a 5xx marks the note.

      A 202 (already in flight) is a success. Any endpoint's 426 now raises a full-screen "Update
      AlgoMinutes" cover (its button opens TestFlight, `UPDATE_URL`). The Files list's "Retry" goes through
      `env.retry` like the note screen, so it re-uploads a recording still on disk. Unit-tested (the
      mapping, the 402 body, the 426 notification, the update URL).
    - [x] ~~**E2, the client watchdog**~~ **done (#124):** a slow note is reported ("taking longer than
      usual"), never failed from the app; the sweep fails a stuck run, Postgres first. The web followed
      (#157).
    - ~~Recording cap~~ **done:** the api caps `/v1/uploads` at 500 MB (#97), and the app checks the same cap
      first (ios-m0-readiness PR).
  - **Web** (off the M1 path): migrate `App.tsx` / `ImportPanel` / `YouTubeImport` to the async flow
    (`POST /v1/uploads` + `/v1/process`, then Firestore status), and `lib/*` to the `/v1` paths.

## 4. Verification gaps (could NOT verify without deps / credentials / devices)

Everything below was structurally verified (files parse via `node --check` / `xcodegen generate`, all
invariant checkers pass, gitleaks clean) but **nothing was installed, built, or deployed** — that needs
A4 credentials + A11 build wiring.

> **A11 progress (PR-02, 2026-09-20):** `npm install` now succeeds (`package-lock.json` committed);
> the four shared TS libraries (`contracts`, `db`, `ai`, `tokens`) typecheck clean under a real root
> `npm run typecheck`; `npm run contracts:openapi` runs and is deterministic (regenerated
> `openapi.v1.json`, 46→50 schemas, zero dropped). **Still open, deferred to their own PRs:**
> - ~~**`apps/web` typecheck**~~ **clean (web-typecheck PR), and CI's `web-build` job runs it.** Fixes: vite
>   client types, the dead Firestore database id, the shim's `CapacitorHttp.request` signature, a
>   `BillingPeriod` type export from the contracts, the home actions typed with `satisfies`, and
>   `stopBroadcast` on the recorder shim. The deferred `noImplicitAny` / `noUncheckedIndexedAccess` stay off.
>   Was: 14 `strictNullChecks` errors remain (missing `./plugins/BackgroundRecorder`
>   + `./plugins/BroadcastRecorder` modules, `import.meta.env` needs `vite/client` types, `BillingPeriod`
>   used as a type, a `NoteType` assignment, `authedFetch` arg count) **plus** the deliberately-deferred
>   `noImplicitAny` (1181) / `noUncheckedIndexedAccess` (91) from `apps/web/tsconfig.json`. Not on the
>   TestFlight path; belongs with the A8/web PR. `npm run typecheck` deliberately excludes `apps/web`.
> - **Swift/Kotlin model codegen** (`npm run contracts:models`) needs a real JDK (only the macOS `java`
>   stub is present) **and** the generated `generated/{swift,kotlin}` are not yet consumed by any client
>   — wire when a client first imports them (PR-15 onward). The internal PR-02 schema rename kept every
>   `.openapi()` name, so the OpenAPI output names are unchanged and no client-visible contract moved.

- **No `npm install` / build / deploy** anywhere: services, web, contracts codegen, iOS, Android are
  unbuilt. Full compilation + runtime import resolution (`@algominutes/*` workspace links, `@algominutes/db`
  TS via `tsx`, exports maps) is unverified until deps are installed.
- ~~**Service Dockerfiles** vendor workspace packages via `COPY packages/* …`; full npm-workspaces build is
  `TODO(build A11)`.~~ **Done (PR-03):** all 8 service Dockerfiles rewritten to one canonical
  repo-root-context pattern (`npm install -w <svc> -w db -w ai -w contracts`); `.dockerignore` added.
  Fixed along the way: (a) 6 services launched with `node` but import `@algominutes/db` (TS source) →
  now run under **tsx** (added as a runtime dep); (b) `@algominutes/db` imported **`firebase-admin`**
  without declaring it (every repo-layer boot would have crashed) and `@algominutes/ai` used
  `google-auth-library`/`pg` undeclared → all now declared; (c) api/billing never copied
  `packages/contracts` (a `db` dep) → now vendored. **Boot-time env validation** added
  (`packages/ai/src/require-env.cjs`, wired into all 8) — a service with missing infra env now exits
  `78` with a structured `env_validation_failed` line instead of silently defaulting (the wasssup
  deploy trap). Verified locally: embedder/summarizer/extractor fail-fast on missing env and boot to
  `/healthz` with it. **Local `docker build` is blocked** by a full host disk (94%, Docker VM
  containerd I/O error) — CI (`.github/workflows/docker-build.yml`, matrix over all 8) is the
  authoritative build evidence. **`functions/`** Firebase deploy vendoring `@algominutes/ai` is still
  `TODO(build A11)`.
- ~~**Hard-invariant violation in dead code.**~~ **Resolved (boot-crash fix PR, 2026-09-24):** `packages/db/src/embeddings.ts` was *not* dead — the `@algominutes/db` barrel re-exported it, so every image that imports the barrel (api, billing, notifier) crashed at boot with `ERR_MODULE_NOT_FOUND: @google/generative-ai` (the package was only declared by summarizer/transcoder and hoisting hid it locally). Deleted it and the unused `search-repo.ts` (api uses its own CJS search); dropped the forbidden dep from summarizer/transcoder manifests; `check-no-genai-import.sh` now scans `packages/db`. New guards: `scripts/check-declared-deps.mjs` (invariant: every workspace declares what it imports — also caught billing → `helmet`) and a CI **boot smoke** that starts every image.
- ~~**iOS:** `xcodegen generate` succeeds, but a clean **build** needs A4 signing + SPM resolution.~~
  **Done (PR-05):** the iOS app **compiles for the first time** and all **161 unit tests pass** on the
  simulator (`xcodebuild test`, unsigned). `DEVELOPMENT_TEAM: NY9MS8GSBK` wired in `project.yml`. Fixed
  to compile: two Swift 5.10 strict-concurrency errors (a default-arg `@MainActor` init in
  `RecorderService`, and a `deinit` touching a `@MainActor` Task in `StoreKitService`), and both
  broadcast-extension `Info.plist`s were missing every standard `CFBundle*` key (embedded-binary bundle
  id resolved to `(null)`). `FirebaseApp.configure()` traps without `GoogleService-Info.plist`, so the
  app now configures Firebase with **placeholder options** when the plist is absent (CI / app-hosted
  tests) — no live calls, no committed config. CI: `.github/workflows/ios.yml` (macOS runner,
  path-filtered, unsigned). The re-homed **broadcast extension** still needs its full runtime wiring
  (`RPSystemBroadcastPickerView`, App-Group handoff) — a real App Group (A4) + a device (PR-27/29).
- **Android:** no gradle build run; A3 delivered only the audio layer + interface (the full Compose app,
  permission/consent flow, launcher Activity are **B2**).
- **Web:** no `vite build`; `App.tsx` still has native branches behind web-safe shims — full de-Capacitor +
  generalisation is **A8**.
- **contracts:** `openapi/openapi.v1.json` is hand-written to match the zod schemas; `npm run openapi`
  (regenerate) and `npm run models` (Swift/Kotlin codegen, needs a JVM) were not run. Verify
  `@asteasolutions/zod-to-openapi@8` + `zod@4` resolve together at A4.
- **extractor:** Docker image needs `poppler-utils` + `yt-dlp`; OCR image pre-processing (`sharp`) dropped
  for P0; captionless YouTube returns a permanent 422 (STT is the transcoder's job).
- **`check-migrations.sh`** compares against `origin/main`; only meaningful in CI after the first push.
- **Test suite (PR-04):** vitest + `ci.yml` (typecheck + vitest + node:test) are wired and green. Seeded
  with tests written against algominutes' *actual* modules — PII redaction (invariant-critical), the
  boot-time `require-env` helper, and contract-schema/OpenAPI round-trips — plus the pre-existing
  transcoder-provider and diarisation-DER node:test suites. The 61 `.test.ts` files in
  `wasssup-meeting/tests` were **not** bulk-ported: the shared code diverged (e.g. `redaction.cjs` is
  337 vs 172 lines), so a verbatim port would fail. Growing coverage of the diverged pipeline
  (gemini-call ladder, note-terminal/idempotency, cloud-tasks-deadline, summarizer map-reduce,
  embedder) belongs with the PRs that touch each area — each such PR adds tests for its own change.
- **Client identifiers + `wassup`/`clinical` naming still present throughout** — by design. The global
  rename is **A5**; identifier replacement is **A4/A5**. So the BUILD-PLAN "Verify" grep for
  `wassup|clinical` will NOT be clean until A5 — expected at this stage.
- **Root `tests/` vitest suite was NOT ported in A3** (found during A6.1). The source had ~24 test files
  (summary-templates, redaction, contract, idempotency, share-links, etc.). They are PLATFORM assets the
  A11 test strategy relies on — port + adapt them (paths → new layout) as an A3/A11 follow-up. A6.1's
  template change updated the iOS `WassupTests` assertions but there is no server-side
  `summary-templates.test.ts` in the repo to update yet.
- **A6.7 is foundation-only:** the catalog + `t()` accessor + web wiring are in, but the **exhaustive
  per-file string migration** in `apps/web`/`apps/ios` and the **iOS/Android string codegen**
  (json → `Localizable.strings`/`strings.xml`) are pending (TODO in `packages/tokens/README.md`).
- **A6.1 is a three-client contract change:** `openapi.v1.json` + iOS enum were hand-updated to match;
  `npm run openapi` / `npm run models` regeneration was not run (no deps) — regenerate at A4/A11 and
  confirm they match the hand edits.

---

## A4 identifiers needed from you

The run stops before A4 because these cannot be invented (BUILD-PLAN §Working-constraints: "Missing an
identifier … Stop and ask. Never invent one"). Provide each and A4 can proceed:

| # | Identifier | Used by | Notes |
|---|---|---|---|
| 1 | **Apple Developer Team ID** (Algorythmos') | iOS signing (`project.yml`) | Replaces client `HX9DZ34625`. |
| 2 | **iOS provisioning profile name(s)** (app + broadcast extension) | iOS signing | Replaces `"Wassup App Store"`. |
| 3 | **iOS bundle IDs** — app + broadcast extension | iOS | ✅ `com.algorythmos.algominutes` + `.BroadcastExtension`, registered 2026-09-26 (the setup-UI target was deleted in #172). |
| 4 | **App Group identifier** | iOS capture handoff | Default assumed: `group.com.algorythmos.algominutes`. Confirm (retrofits break silently). |
| 5 | **GCP/Firebase project IDs** — staging + production | all services, Firebase | Two projects. Replaces client `wassup-meeting`. |
| 6 | **GCP project numbers / messaging sender IDs** (per env) | FCM, OAuth | Regenerated with the projects. |
| 7 | **Firebase app configs** (regenerate, don't copy): `google-services.json` (Android), `GoogleService-Info.plist` (iOS), web config | clients | Per environment. |
| 8 | **Android `applicationId` + package** | Android | Default assumed for A5: `com.algorythmos.algominutes`. Confirm. |
| 9 | **Android upload keystore** (fresh) + Play App Signing enrolment | Android signing | Never reuse client keystore; store upload key safely. |
| 10 | **Cloud Run / Cloud Tasks / Postgres / bucket names** (per env) | services | Stand up fresh per environment. |
| 11 | **Domain(s)** | web, API, CORS | ✅ Site `algominutes.algorythmos.com`; api on `run.app` (DECISIONS, 2026-09-26). |
| 12 | **GCP billing budget + daily spend cap figures** (§4.6) | cost circuit breaker | Needed before first load test. |
| 13 | **Stripe / App Store Connect / Play Console accounts** | billing (A9) | Enrol both small-business programmes before first sale. |
