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
git-ignored). **Prod: ⏳ pending.** Remaining, all from a `gcp-admin@algorythmos.com` shell:

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

## 4. Verification gaps (could NOT verify without deps / credentials / devices)

Everything below was structurally verified (files parse via `node --check` / `xcodegen generate`, all
invariant checkers pass, gitleaks clean) but **nothing was installed, built, or deployed** — that needs
A4 credentials + A11 build wiring.

- **No `npm install` / build / deploy** anywhere: services, web, contracts codegen, iOS, Android are
  unbuilt. Full compilation + runtime import resolution (`@algominutes/*` workspace links, `@algominutes/db`
  TS via `tsx`, exports maps) is unverified until deps are installed.
- **Service Dockerfiles** vendor workspace packages via `COPY packages/* …`; full npm-workspaces build is
  `TODO(build A11)`. **`functions/`** Firebase deploy must vendor `@algominutes/ai` — `TODO(build A11)`.
- **iOS:** `xcodegen generate` succeeds, but a clean **build** needs A4 signing + SPM resolution (network).
  The re-homed **broadcast extension** is declared + embedded but its full runtime wiring
  (`RPSystemBroadcastPickerView`, App-Group handoff) needs a real App Group (A4) + a device (A11).
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
