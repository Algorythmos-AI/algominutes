# AlgoMinutes → internal TestFlight (M1): status + remaining PR train (rev 5 — loophole pass)

## Context

Goal: ship **AlgoMinutes** — a 100% native Swift/SwiftUI meeting recorder that reliably captures 2–4 h
meetings — to **internal TestFlight at the full M1 bar** (owner: no fast-track), with the **Algorythmos
"ai" mark unchanged** as the app icon (wordmark becomes "AlgoMinutes"), and the **broadcast extension wired
before build 1** (owner).

Audit (2026-09-23): iOS is **fully native** (no WKWebView/SFSafariVC/JS bridges; UIKit only via justified
representables). Code/architecture **A-**, UI polish **B**, TestFlight readiness **C** — gaps are wiring,
identifiers, brand, release tooling and a live backend, not code quality.

## Where we are

| Stage | PRs | Status |
|---|---|---|
| A — make it build | PR-01…05 | ✅ merged |
| B — backend | PR-06 | ✅ merged (#6) incl. the fix-ups below — staging apply pending gcp-admin |
| B | PR-07…16 | not started |
| C/D → M1 | PR-17…31 | not started |

## Bugs found in this review (fix before anything else)

**PR-06 fix-up commit (landed in #6, `e7d0c61`):**
1. **App traffic would get 403.** All Cloud Run services are IAM-private (only `run-jobs` is invoker). `api`
   (Firebase-token auth in-app) and `billing` (public store/Stripe webhooks, signature-verified) must be
   publicly invokable → add `allUsers` `run.invoker` on **api + billing only**; workers stay private.
2. **Services that use Postgres don't get DB config.** `db_services` = transcoder/summarizer/embedder, but
   `api`, `billing` and `notifier` import `@algominutes/db` too → add them to `db_services` (PG env +
   `PGPASSWORD` secret ref) and add the Postgres `oneOf` to their `requireEnv` specs (`services/{api,billing,notifier}/src/index.js`).
3. Record in the PR: deterministic `*_URL` hostnames and the extractor bucket (`imports`) are **assumptions
   verified by the PR-07 smoke**, not facts.

**Plan-level fixes folded in below:** Staging build configuration for M1 (Release = prod, which doesn't exist
until after M1); Apple-token revocation done client-side via Firebase (no server secret); characterization
tests *before* refactors; Xcode pinned early; macOS-minute budget; disk space.

## Human-only prerequisites (start now — they gate the train)

1. ✅ GitHub Actions billing cleared (2026-09-23). To cap macOS cost (15 iOS PRs ahead), optionally
   register this Mac as a **self-hosted runner** for `ios.yml` (I'll wire it if you choose).
2. **Free local disk** (host is 94% full): ≥ 30 GB for Xcode archives, simulators and Docker.
3. **Resume staging** as `gcp-admin@algorythmos.com` after PR-06 merges: `terraform plan/apply` + `npm run migrate`
   (`docs/runbooks/resume-staging-and-deploy.md`); paste me the plan output. Spends trial credit (expires 14 Nov).
4. **Firebase (staging)**: register iOS app `com.algorythmos.algominutes`; enable Apple/Google/anonymous;
   upload an **APNs auth key (.p8)** (covers dev + TestFlight/production push) → `GoogleService-Info.plist`.
5. **App Store Connect**: create the app record; accept agreements; add internal testers. App Group and bundle
   ids register via automatic signing on first archive.
6. **"ai" mark as vector** (SVG/PDF). Not a blocker: PR-21 ships a geometric redraw for sign-off; the vector swaps in later.
7. **Rotate the leaked upstream Gemini key** (urgent, independent). 8. A real iPhone for M1.

## Rules (unchanged + two additions)

Strictly serial; one concern per PR (≤ ~600 lines); evidence in every PR; audit shared code first;
sub-agents after writes; new migrations only; contract changes regenerate models and update web + android.
**New:** (a) every refactor PR is preceded by characterization tests that pin behaviour; (b) every iOS PR
builds on **both** CI Xcode (pinned, PR-17) and local Xcode 26.x with `-warn-long-expression-type-checking=300` = 0.

---

## Stage B — backend (PR-06…16)

**PR-06** ✅ Cloud Run/WIF/queues + fix-ups (#6) → **you apply** (runbook).
**PR-06b `docs: plan rev 5`** — replace `docs/plans/A11-release.md` with this plan (docs-only).
PR-07 deploy workflow (WIF) + Vertex/pipeline smoke that asserts real service URLs match the env ·
PR-08 verified model ladder · PR-09 one upload cap + storage/firestore rules in repo · PR-10 transcoder
per-chunk fan-out · PR-11 summarizer map-reduce + salvage · PR-12 embedder batch/fail-loud + delete dead
`packages/db/src/embeddings.ts` + extend `check-no-genai-import.sh` to `packages/db` · PR-13 stuck-note
sweeper + spend-defer + Scheduler triggers · PR-14 retire sync `process-audio` · PR-15 entitlement preflight
+ reconciled metering + tester grant · PR-16 resumable uploads + rate limits. (Detail: rev 3.)

## Stage C — native iOS: correct, great, crash-safe (PR-17…29)

**PR-17 `fix(ios): /v1 client + build configurations`** — every `api/*` → `/v1` contract path; three configs:
**Debug** (placeholder Firebase OK), **Staging** (optimized, staging backend + staging plist — *this is what M1
archives*), **Release** (prod, used from Stage E); per-config `GoogleService-Info.plist` copy phase and **build
fails in Staging/Release if the plist is missing**; `X-AlgoMinutes-Client`; 426 screen; transcript paging via
`/v1/notes/read`; **pin Xcode + SPM cache in `ios.yml`**.

**PR-18 `fix(ios): identifiers, entitlements, push`** — new reversed client id; register `algominutes://`; App
Group + `aps-environment` (Xcode sets `production` on archive — TestFlight uses production APNs) +
`remote-notification`; FirebaseMessaging token exchange; CI grep bans `909388484461`.

**PR-19 `refactor(ios): foundations + characterization tests`** — first add `URLProtocol`-mocked tests for
APIClient error mapping, deep-link parsing, consent gate, auth request shaping; then `AppLog` → `os.Logger`
(privacy-annotated, own file); service protocols; replace `nonisolated(unsafe)` in `BackgroundUploadService`/
`UploadService` with an actor; `SWIFT_STRICT_CONCURRENCY: complete` using `@preconcurrency import` for Firebase/
GoogleSignIn (if it exceeds ~600 lines, split per module into PR-19a/19b); fix `SpeakerLabel.swift:40` unwrap.

**PR-20 `refactor(ios): split god objects`** — `AppEnvironment` → root + `RecordingCoordinator`; `APIClient` by
domain with `Codable`; split `SettingsView` and the test file. Behaviour-preserving; PR-19 tests must stay green.

**PR-21 `feat(ios): AlgoMinutes brand`** — icon = unchanged "ai" mark on #7B2FF7→#4F2BE0 gradient, no
"ALGORYTHMOS" text on the icon (HIG); light (opaque), **dark (transparent background, iOS 18 style)**, tinted
(grayscale on transparency); `Logo` = mark + new **AlgoMinutes wordmark**; `Theme.swift` brand tokens,
accent/tint → brand, gradient primary button (contrast ≥ 4.5:1 checked); launch `#0B0B10` + mark; rename `Owll*`;
delete Rajdhani/`UIAppFonts`/`BrandFontTests`/`Splash.imageset`; sync `packages/tokens/tokens.json`.

**PR-22 `feat(ios): crash-safe capture engine up to 4 h`** — measured choice (AVAudioEngine rotating segments +
passthrough concat vs AVAssetWriter fMP4); zero-gap continuity test; `kill -9` loses ≤ 1 segment; 4 h locked;
moov-front output; continuous disk check; cap from entitlement; never blocked offline. Segment format is
designed for reuse by PR-25.

**PR-23 `feat(ios): interruption/route hardening`** — port wasssup ADR-0009 policies; thermal/battery/disk.

**PR-24 `feat(ios): uploads that always finish`** — background resumable uploads on PR-16; size-scaled stall
policy; cancel-and-join; Wi-Fi-only; duration-scaled `StuckBudgets`.

**PR-25 `feat(ios): system-audio capture (broadcast extension)`** — `RPSystemBroadcastPickerView`; extension
streams AAC segments (PR-22 format) into the App Group with **no Firebase/large deps linked** (50 MB extension
memory cap); app imports them as a new note; replace template `BroadcastSetupViewController`; consent applies;
honest copy; privacy manifest + review notes; `project.yml` kill-switch.

**PR-26 `feat: pause + bookmarks`** — offline bookmark sidecar → migration `014`, `/v1/notes/:id/bookmarks`;
contract regen + web/android updated.

**PR-27 `feat(ios): Live Activity + Dynamic Island`** — widget extension (4th bundle id, App Group),
`NSSupportsLiveActivities`, timer + pause/bookmark App Intents.

**PR-28 `feat(ios): follow-up sender + long-note playback`** — port `FollowUpSender`/`MailAppAvailability`/
`LSApplicationQueriesSchemes`; seek-to-2:45:00 < 2 s.

**PR-29 `feat(ios): compliance & quality polish`** — **Sign in with Apple revocation on delete** via re-auth →
`Auth.auth().revokeToken(withAuthorizationCode:)` (client-side, no server secret); String Catalog +
`String(localized:)`; accessibility pass; Xcode Privacy Report clean; XCUITest smoke (launch → record → note →
settings → delete).

## Stage D — release → **M1 internal TestFlight** (PR-30…31)

**PR-30 `build(ios): release script + ASC setup`** — `apps/ios/scripts/release.sh` (xcodegen → archive
**Staging** config with Xcode 26.x → export/upload; `ExportOptions.plist`; automatic signing
`-allowProvisioningUpdates` for all 4 bundle ids; ASC key via env; fetches the env plist; refuses a duplicate
build number); `scripts/asc-setup.mjs` (metadata from `docs/STORE-LISTING.md`, beta groups, subscription
products); `.storekit` file; paywall entry points flag-hidden; fix `algominutes.app`/`.com` mismatch.

**PR-31 `chore(ios): 1.0.0 (1)`** → **M1** evidence on a real iPhone: guest → 3 h locked-screen recording with a
call mid-way → cellular upload → chaptered summary; a separate broadcast-captured note processed; one `traceId`
across services; psql rows; search/chat find minute-170 content; delete account → rows gone in PG + Firestore,
Apple token revoked (log line).

## After M1 (scope unchanged)

Stage E → external TestFlight: PR-32 billing (Apple JWS x5c, ASSN, live paywall, sandbox on prod) · PR-33
diarisation + speaker chip · PR-34 single deletion path + tenant tests · PR-35 prod + observability + restore
drill (first **Release**-config build) · PR-36 marketing/legal site. Stage F → App Store: PR-37 captions ·
PR-38 calendar · PR-39 folders/search · PR-40 note detail · PR-41 DeviceCheck · PR-42 submission.

## Verification

| Gate | Proof |
|---|---|
| PR-06 | `terraform validate`; after your apply: `curl` api `/v1/health` 200 unauthenticated, a worker returns 403 unauthenticated; `\dt` |
| Each iOS PR | tests green on pinned CI Xcode + local 26.x; slow-expression check 0; after PR-19 strict-concurrency warnings 0 |
| PR-21 | icon light/dark/tinted on device; `grep -ri 'owll\|rajdhani'` empty |
| PR-22/25 | continuity + kill-recovery tests; device kill at min 30 keeps ≥ 29 min; broadcast handoff log |
| PR-29 | XCUITest smoke green; Privacy Report clean; revocation logged |
| M1 | PR-31 evidence list |

## Risks

- Human prerequisites are the real critical path — start them now.
- PR-22 and PR-25 are the hardest; PR-25 is the top App Review risk (kill-switch kept).
- macOS CI minutes across 15 iOS PRs — self-hosted runner recommended.
- Unverifiable-here assumptions (URLs, buckets, IAM) are each tied to a named smoke check, not asserted.
