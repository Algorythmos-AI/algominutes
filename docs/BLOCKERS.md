# Blockers & handoffs — AlgoMinutes

Batched list of everything that needs a human decision or credential. Nothing here stopped the A2/A3
run; each item has a safe reversible default already applied. Grouped by type.

## 1. Needs your action before/at A4 (repo & infra)

- [ ] **Push `main` + enable branch protection.** The repo is committed locally with the remote set to
      `Algorythmos-AI/algominutes` but nothing has been pushed (see DECISIONS.md). When ready:
      `git push -u origin main`, then protect `main` (require PR + CI green, no direct pushes). Default
      applied: local-only commits.
- [ ] **Rotate the exposed Gemini API key + purge source history** (EXTRACTION-AUDIT §5). Source-side,
      in `~/src/wasssup-meeting`; not touched by this run.

## 2. A4 provisioning

**Staging: ✅ DONE** — `terraform apply` live (111 resources), Firebase enabled (Blaze), Google sign-in on,
Web + Android apps registered, `apps/web/.env` + `apps/android/app/google-services.json` wired (both
git-ignored). **Prod: ⏳ pending.** Remaining, all from a primary-account (`algorythmos.france@gmail.com`) shell:

- [ ] **Apply prod:** bootstrap `algominutes-prod-tfstate`, then `terraform apply` in
      `infra/terraform/envs/prod` (runbook `gcp-provisioning.md`).
- [ ] **Prod Firebase:** enable Firebase (Blaze), Google sign-in, register Web + Android apps, download a
      **fresh** `google-services.json` + create a **prod** `apps/web/.env` — never reuse staging's values
      (runbook `prod-firebase-config.md`).
- [ ] **Run migrations** against the staging Cloud SQL now (it's live) and prod after apply (runbook §6).
- [ ] **Re-scope `algominutes-prod-budget`** from the whole billing account to the prod project only
      (INFRASTRUCTURE open item #2 — still outstanding).
- [ ] Confirm the domain registrar for `algominutes.com` / `.com.au` (INFRASTRUCTURE §6 TODO).
- **iOS Firebase app pending the Apple Team ID (`TODO(A4-apple)`)** — can't register the iOS app or
  download `GoogleService-Info.plist` until enrolment completes. Android upload keystore also pending
  (Track B). Left untouched, as instructed.
- Incidental finding (A5/A8, not A4): `apps/web/src/lib/apiUrl.ts:1` hardcodes
  `https://wassup-meeting.web.app` as the prod API origin — a client reference to replace at rename time,
  and the web currently ignores `VITE_API_BASE_URL` on local/capacitor hosts in favour of it.

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
- [ ] Cloud SQL PITR + Storage lifecycle/version expiry ≤30 days (makes the deletion promise true) + Cloud
      Logging retention; the scheduled retention-enforcer + trial-expiry sweep jobs.
- [ ] Server-side attestation verification (DeviceCheck key / Play Integrity) so the #7 device hash is
      trusted, not just accepted; needs a real device to verify end-to-end.

**Engineering follow-ups (no external input):**
- [ ] Consolidate the two account-deletion paths (legacy Settings modal → Cloud Function vs new
      `/delete-account` page → `/v1/account/delete`) onto one.
- [ ] Extend `AnalyticsEvent` with support/terms/retention/deletion events + emit them (funnel is complete
      without them).
- [ ] Reconcile iOS `StoragePaths.maxBytes` 50MB vs 120MB doc (carried from A7).

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

## 3. Business/engineering decisions deferred (safe default applied)

Full rationale for each is in `docs/DECISIONS.md`. The ones a human may want to revisit:

- **db-job → scheduled Cloud Run job** (not folded into `api`). Reversible.
- **Web keeps client-side extraction** (pdfjs/mammoth/tesseract) for now; switching the web to call
  `services/extractor` is a follow-up.
- **All `shared/` lives in `@algominutes/ai`** (incl. pg-query/storage-paths). If you'd prefer pg-query in
  `@algominutes/db`, it's a small move (the service `sharedRequire` ai→db fallback already tolerates it).
- **`main` not pushed / not protected during this run** (see §1). 
- **A5 rename follow-ups (need Apple/infra, not code):**
  - iOS `Info.plist` reversed-OAuth URL scheme still references the OLD client OAuth id
    (`com.googleusercontent.apps.909388484461-…`); regenerate when the iOS Firebase app is registered
    (`TODO(A4-apple)`). Not a `wassup` token, so it doesn't fail the grep.
  - Backend domains `api.algominutes.com` / `algominutes.com` are wired in code but **not confirmed live**
    (`TODO(A9-infra)`) — verify DNS/hosting when infra stands up.
  - The **app-side** iOS entitlements has the keychain group but no `application-groups` entry; the broadcast
    handoff needs the app added to `group.com.algorythmos.algominutes` when the extension is wired (below).
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
  1,500-min Pro tier at A$29 requires COGS well under 1¢/min. See PERFORMANCE-BUDGET.md.
- **A7.2 background upload is gated OFF by default** — the new URLSession-background/chunked path can't be
  built/tested here; verify on-device (A11) before flipping the default. Firebase `putFile` remains the
  working fallback. The `/v1/uploads` GCS resumable-session endpoint is `TODO(A11)` (no GCS creds to test).
- **A7.3 real push is `TODO(A4-apple)`** — iOS APNs/FCM registration needs the iOS Firebase app
  (GoogleService-Info.plist), pending the Apple Team ID. The flow is coded; the notifier service can send
  once tokens register. Android push is B2.
- **iOS `StoragePaths.maxBytes` = 50MB vs a 120MB doc/UploadService comment** — flagged by the A7 map;
  reconcile before finalising upload size limits (not changed this run).
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
- [ ] **Pre-existing, found by the auditors (queued):**
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
        Residual (narrow, pre-existing): two duplicates can both pass the pre-check within milliseconds.
        If the loser then fails the size or rate check, `failNote` can mark the winner's note `error`,
        and the loser has already spent rate-limit budget. Close it in PR-16 by moving the pre-queue
        rejections after `markQueued`, or by guarding `markError` against in-flight notes.
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
      - [ ] **apps/web/src silent catches (27):** mostly `resp.text().catch(() => '')`, plus
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

- [ ] **The web build is broken under the workspace install (pre-existing).**
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
- [ ] **Web toolchain: vite 6 → 8 plus `@vitejs/plugin-react` 6** (#30 declined; plugin-react 6
  requires vite ^8). Do it in one apps/web PR, together with the tesseract-asset build
  fix above and a web-build CI job, so the result is actually verified.
- [x] **Resolved by removal (retire-process-audio PR):** the synchronous `/v1/process-audio` route and
  the `@google/genai` dependency are gone. Was: **`@google/genai` 1 → 2** (#29 declined): its only user is
  `services/api/src/routes/process-audio.js`, the synchronous route plan PR-16 retires.
  Delete the dependency with that route; don't migrate it.
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
- [ ] **Transcoder fast path sends audio inline to Gemini.** 3.5-flash lists audio
  input as supported, but `vertex-smoke` only exercises text. Add an audio-fixture
  call to the smoke, or verify a short recording end to end on staging.
- [ ] **Embedding migration before 2027-04-01:** `text-embedding-004` → `gemini-embedding-001`
  (served in Sydney; set `outputDimensionality: 768` to keep `vector(768)`). Vectors
  from different models don't compare, so: add `embeddings.model` to every query,
  re-embed all rows with a db-job backfill, then switch `EMBED_MODEL`. The
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
- [ ] **Upload sessions accumulate:** expired rows are never deleted. Add cleanup to the PR-15 sweeper.
- [x] **Fixed (generation-at-write PR):** `markSummaryReady` takes the generation the run read and
  only writes if it's still current (`summary_generation = $3` in the workspace-scoped UPDATE). A superseded
  run writes nothing in either store, logs `summarizer_generation_superseded`, and doesn't notify. Tested,
  and mutation-checked. Was: **The summarizer's generation guard is checked before Gemini, not at the
  write** (found by the dual-write audit of the summarizer-via-repo PR). The run read `summary_generation`,
  spent minutes in Gemini, then wrote without re-checking it, so an older run could land over a regenerate
  claimed in that window.
- [ ] **Postgres note writes still bypass the repo layer** (found by the dual-write audit of the
  generation-at-write PR; `check-no-direct-firestore` only sees Firestore, so nothing gates these):
  - `services/transcoder/src/fast-path.js:71-101`: the short-audio path writes transcript lines, the
    summary, action items and key decisions inline. It has no generation guard, and it sets status
    through `transcoder/src/db.js upsertNoteStatus`, which is `UPDATE notes … WHERE id = $1`, with no
    workspace scope and no `deleted_at` check. A task for a deleted note (or a mismatched payload)
    still updates it. (Also `startMs = intelligence.MODEL_LADDER && …` is a no-op guard; harmless while
    the ladder is exported, fragile if it moves.)
  - `services/transcoder/src/db.js` (chunks; its status write is now workspace-scoped, see the
    workers-note-gone PR), `packages/ai/src/note-edit.cjs:104-131`
    (manual edits), `packages/ai/src/embeddings.cjs:137-142`, and `functions/index.js:117`
    (`workspace_id = COALESCE($2, workspace_id)`: a null workspace matches any note).
  - Fix with PR-12 (the transcoder rewrite): move the transcoder's writes into notes-repo with
    workspace-scoped, `deleted_at`-aware SQL, and route the fast-path's final write through
    `markSummaryReady`. Then add a Postgres counterpart to the gate (writes to `notes` / `summaries` /
    `action_items` / `key_decisions` / `transcript_lines` outside `packages/db`).
- [x] **Fixed (firestore-gate-batch-writes PR):** the gate now also flags a write whose *first argument*
  is a document ref (`batch.delete(db.doc(p))`, `tx.set(noteRef, …)`, bulk writes), a bare `ref`
  receiver (the old `/Ref$/` missed it; `share-links` relied on that), and `snap.ref.update(…)`.
  Deliberate non-note writes carry a reasoned `// firestore-write-ok: <reason>` on the line or the line
  above. The two rate-limit counters are marked. The account-deletion cascade is marked as a tracked
  exception (below). Was: **The direct-Firestore gate misses batched and transactional writes.**
- [ ] **⚠️ M1: deletion doesn't work on the new backend. A deleted note stays in Postgres, stays
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
    - [ ] iOS calls the route instead of deleting the doc (PR-17). Then Firestore rules stop clients
      deleting note docs.
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
      - **R1:** `markQueued` can bring back a note deleted between the api's doc check and its own
        transaction. Its INSERT re-creates the Postgres row, its `set(merge)` re-creates the doc, and a job
        is queued. Fix: `update()` for the doc (the route already proved it exists), and refuse inside the
        transaction when a `storage_purges` row exists for the note.
      - **R2:** the web client's `setDoc(…, { merge: true })` writes (`apps/web/src/lib/noteStatus.ts:4`,
        `App.tsx`) can re-create a doc deleted from another device. That's fixed by the web's `/v1`
        migration.
      - **R3:** ~~a YouTube permanent failure mirrors `error` to Firestore only~~ **fixed
        (youtube-permanent-failure PR):** it now calls `noteTerminal.markNoteFailed`, Postgres first, so a
        retry isn't refused for 3 h. Still open: `chunking` and `summarizing` are mirrored with no matching
        Postgres status write.
    - [ ] A client that still holds a GCS resumable-session URI can finish uploading after the delete. Its
      server-side upload session is gone, so it can't be completed or processed, but the object lands. The
      PR-15 sweeper should also remove objects of notes that don't exist.
    - [ ] The PR-15 sweeper drains `storage_purges` (retries with backoff), and the admin view / alert counts
      the rows that stay stuck.
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
      - **Bucket versioning keeps "deleted" audio** as noncurrent versions (every bucket is versioned,
        with no noncurrent lifecycle rule), for note deletion too. Next PR: delete every generation in
        the purge, and add a noncurrent-version lifecycle rule (Terraform; your apply).
      - Alert on `delete_account_incomplete` and on `storage_purges.attempts >= N` (PR-16c). A permanently
        failing object blocks an account's deletion (fail closed), and must page someone.
      - Single-note deletion should also cancel the note's open upload session (account deletion does).
      - Before shared workspaces ship, account deletion must transfer or refuse a shared workspace. Today
        an owned workspace goes with its owner, members' notes included.
      - The api's `verifyIdToken` doesn't check revocation. The tombstone blocks the write paths that could
        re-create the account, but a deleted account's token can still *read* (nothing is left) for up to
        an hour. Clients must sign out on the 200.
      - Firestore rules (PR-11) should stop a signed-in client re-creating `workspaces/{ws}` docs after
        deletion. The web app does that at sign-in (`App.tsx:648`).
      - The sweeper (PR-15) should prune completed tombstones after the retention window, and drain
        `storage_purges`.
      - `process-intelligence.js` also writes root Firestore `analytics` docs. `analytics_events` exists in
        Postgres, so stop writing them.
    - [ ] Retire `functions/` onNoteDeleted. It isn't deployed, and its prefix sweep is unsafe.
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
- [ ] **The note-delete cascade hop has no traceId.** `functions/index.js onNoteDeleted` is a Firestore
  trigger, so there's nowhere to carry the api's id. It gets fixed with plan PR-34 (the single deletion
  path): the api enqueues the cascade as a Cloud Task, which carries the id like every other hop.
- [ ] **Workers can't log `userId`: no task payload carries `uid`.** The api has `req.uid` at kickoff, so
  add `uid` to the kickoff payload, and have the transcoder pass it on to the summarize and embed payloads.
  Then the transcoder, embedder and summarizer entry loggers can bind it. (Task payloads are internal and
  aren't in `packages/contracts`.) Small; queued.
- [ ] **No test covers the summarizer skipping `onReady` when `markSummaryReady` wrote nothing.** The
  repo side is tested. There is no handler-level summarizer test yet (it needs a fake Gemini ladder). Add
  it with PR-13 (map-reduce), which rewrites this handler anyway.
- [ ] **Postgres connections vs `db-f1-micro` (staging).** That tier allows about 25 connections. Each
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
- [ ] **Still open in CodeQL** (triage next):
  - `js/polynomial-redos` in `redaction.cjs` (the PII pre-scrub runs over whole 2–4 h transcripts);
  - `js/log-injection` in `client-error.js`;
  - `js/incomplete-multi-character-sanitization` in the YouTube extractor;
  - `js/insecure-helmet-configuration` ×2 (the api disables CSP by design, since it serves JSON only);
    dismissing needs your yes;
  - `js/missing-rate-limiting` ×6 on billing (its webhooks need provider-aware limits);
  - ~~`actions/missing-workflow-permissions` ×7 and `actions/unpinned-tag` ×14~~ **fixed
    (harden-workflows PR):** every workflow has a least-privilege top-level `permissions` block
    (`promotion-guard` has none), and the six third-party actions are pinned to commit SHAs with
    version comments. Dependabot (`github-actions`) keeps them current.

## Clients still on the legacy `/api/*` surface (2026-09-25)

- [ ] **The iOS app and the web app call the pre-`/v1` API** (`/api/process-audio`, `api/entitlement`,
  `api/verify-purchase`, and more). The new `services/api` serves only `/v1/*`, so **neither client works
  against the deployed backend yet.**
  - **iOS:** plan PR-17 (the `/v1` client, built on the now-complete contract).
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
> - **`apps/web` typecheck** — 14 `strictNullChecks` errors remain (missing `./plugins/BackgroundRecorder`
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
| 3 | **iOS bundle IDs** — app + broadcast extension + setup-UI | iOS | Default assumed for A5: `com.algorythmos.algominutes` (+`.BroadcastExtension`, +`.BroadcastExtensionSetupUI`). Confirm. |
| 4 | **App Group identifier** | iOS capture handoff | Default assumed: `group.com.algorythmos.algominutes`. Confirm (retrofits break silently). |
| 5 | **GCP/Firebase project IDs** — staging + production | all services, Firebase | Two projects. Replaces client `wassup-meeting`. |
| 6 | **GCP project numbers / messaging sender IDs** (per env) | FCM, OAuth | Regenerated with the projects. |
| 7 | **Firebase app configs** (regenerate, don't copy): `google-services.json` (Android), `GoogleService-Info.plist` (iOS), web config | clients | Per environment. |
| 8 | **Android `applicationId` + package** | Android | Default assumed for A5: `com.algorythmos.algominutes`. Confirm. |
| 9 | **Android upload keystore** (fresh) + Play App Signing enrolment | Android signing | Never reuse client keystore; store upload key safely. |
| 10 | **Cloud Run / Cloud Tasks / Postgres / bucket names** (per env) | services | Stand up fresh per environment. |
| 11 | **Domain(s)** | web, API, CORS | Assumed `algominutes.com`, `api.algominutes.com`. Confirm. |
| 12 | **GCP billing budget + daily spend cap figures** (§4.6) | cost circuit breaker | Needed before first load test. |
| 13 | **Stripe / App Store Connect / Play Console accounts** | billing (A9) | Enrol both small-business programmes before first sale. |
