# AlgoMinutes → internal TestFlight (M1): complete plan (rev 7 — loophole pass on the cloud-first plan)

## Context

The goal is to ship **AlgoMinutes** to **internal TestFlight at the full M1 bar**. AlgoMinutes is a 100% native Swift/SwiftUI meeting recorder that reliably captures 2–4 h meetings, backed by a tested, observable backend. It then goes on to production.

Owner decisions already made:
- the full M1 bar comes first;
- the Algorythmos "ai" mark stays as the icon, with an AlgoMinutes wordmark;
- broadcast capture is wired before build 1;
- `integration` = staging (the default branch) and `main` = production;
- **Xcode Cloud** builds for TestFlight and **GitHub macOS** runs the PR tests;
- the repo **stays public for now**, so CI is free.

This plan is cloud-first because the Mac's data volume is **97% full (7.8 GB free)**.

## Loopholes closed in rev 7 (vs rev 6)

1. **Nobody ran migrations on deploy.** New migrations (013, 014…) would never reach staging. New **PR-08b** adds a `migrate` handler to db-job, and the deploy workflow runs it *before* rolling out services. Migrations are expand-only, so running them first is safe.
2. **Keyless deploy was too open for a public repo.** Any workflow on any branch that requested an OIDC token matched the WIF condition. **PR-09** restricts WIF to `refs/heads/integration` (staging) and `refs/heads/main` (prod), and uses GitHub **Environments** (`staging`, `production`); `production` requires your approval.
3. **Squash-merging promotions would make `main` and `integration` diverge** and cause conflicts on every later promotion. Rule: feature PRs are squash-merged into `integration`; **`integration → main` promotions always use a merge commit**.
4. **Path-filtered checks can't be required.** `ios.yml` only runs on iOS paths, so making it required would leave non-iOS PRs pending forever. Required checks are only those that always run: `ci`, `gitleaks`, `invariants`, `docker-build`, plus `promotion-guard` on `main`. `ios.yml` also gains `packages/contracts/**` in its paths.
5. **Xcode Cloud archives the scheme's archive configuration (Release = prod).** M1 needs Staging, so PR-17 adds a second scheme, **`AlgoMinutes-Staging`**, whose archive configuration is Staging.
6. **Crashlytics dSYM upload only ran for `Release`**, so Staging builds would have unsymbolicated crashes. It now runs for every configuration except Debug.
7. **Nightly 3-hour end-to-end run was too expensive** (≈ $3 of STT + Gemini per night, ~$90/month). Instead: nightly **10-minute** fixture, and the **3 h** fixture weekly and on demand. Fixtures live in a GCS test bucket, not git. The e2e run uses a dedicated test account, signing in via Firebase custom token → ID token.
8. **Firestore and Storage rules deploy needs IAM** the deployer doesn't have. PR-11 grants `firebaserules.admin` to `gha-deployer` in Terraform.
9. **Apple token revocation needs Firebase's Apple provider fully configured** (Services ID, key ID, private key). This is added to the human prerequisites.
10. **The trial credit expires 14 Nov, likely before M1.** A budget with alerts at 50/90/100% moves up into **PR-08c**. When the credit ends, you decide whether to keep staging on paid billing or pause it (runbook).
11. **Toolchain drift.** CI tests used Xcode 16.4 while releases use 26.x. The GitHub job is pinned to the newest Xcode on the runner image, and Xcode Cloud to the same major version (PR-17/PR-30).
12. **Contract changes can't update Android** (the full Android app is Track B). Models are regenerated and web is updated; Android is noted as deferred.

## Where we are (2026-09-24)

- **Merged:** PR-01…07, #9 (branch model).
- **Staging** is still paused and empty, waiting for your apply.
- **Disk:** 97% full.

## Where things run

| Work | Runs on | Cost |
|---|---|---|
| Backend typecheck/tests, image builds, CodeQL/Dependabot | GitHub Actions Linux | free (public) |
| Backend integration tests (Postgres 16 + pgvector service container) | GitHub Actions Linux | free |
| iOS unit/UI tests on PRs | GitHub `macos-15` standard runner, newest Xcode pinned | free (public) |
| iOS archive → TestFlight | **Xcode Cloud** (Apple signing, `CI_BUILD_NUMBER`) | 25 h/month included |
| Migrate → deploy → smoke; nightly e2e | GitHub Actions → GCP via WIF, gated by Environment | GCP (trial, then paid) |
| Your Mac | editing, occasional simulator run | — |

If the repo goes private, macOS tests move to Xcode Cloud hours or paid minutes. Record that in DECISIONS.

## Human-only prerequisites (critical path, in order)

1. **Free disk space:** delete `~/Library/Developer/Xcode/DerivedData`, run `xcrun simctl delete unavailable`, and `docker system prune` when your other containers are idle.
2. **Staging:** `terraform plan` as `algorythmos.france@gmail.com` (primary working account) → paste it to me → apply. Then set the repo variables (runbook §3).
3. **Firebase (staging):**
   - register the iOS app;
   - enable Apple/Google/anonymous sign-in;
   - configure the **Apple provider** (Services ID, Key ID, `.p8`) for token revocation;
   - upload an **APNs `.p8`**;
   - hand me `GoogleService-Info.plist` privately (it goes into secrets, never git).
4. **App Store Connect:**
   - create the app record;
   - accept the agreements;
   - add internal testers;
   - connect the GitHub repo to **Xcode Cloud**.
5. **Rotate the leaked upstream Gemini key.** This is urgent, especially with the repo public.
6. **Say yes to branch protection + Environments** (I configure them).
7. **Optional:** the "ai" mark as SVG/PDF.
8. A real iPhone for M1.

## Rules

- Serial PRs: feature branch → squash-merge into `integration` → promotion via **merge commit** into `main`.
- One concern per PR, ≤ ~600 lines, with evidence in the PR.
- Audit shared code first; run the sub-agents; migrations are new and expand-only.
- Characterization tests come before any refactor.
- Each backend fix adds tests to the harness; each iOS PR passes the pinned CI Xcode with the slow-expression check at 0.

---

## Stage B — backend: correct, tested, observable

**PR-08 `test: backend integration harness`**
- Postgres 16 + pgvector service container, with migrations applied.
- Integration tests:
  - repo-layer upserts: replaying a task writes no duplicate rows;
  - the **two-workspace isolation test**, including a mutation check that fails if the membership filter is removed;
  - route-vs-OpenAPI contract;
  - fakes for Tasks/Vertex/GCS behind the existing seams.

**PR-08b `ci(deploy): migrate before rollout`** — db-job `migrate` handler (it reuses `scripts/migrate.ts` logic and is idempotent); the deploy workflow runs the job and waits for success before rolling out services; smoke asserts `schema_migrations` is at head.

**PR-08c `infra: budgets + alerts`** — a staging budget scoped to the project, with email alerts at 50/90/100%; runbook section for the end of the trial.

**PR-09 `ci: security for a public repo`**
- CodeQL (JS/TS + Swift), Dependabot (npm/SPM/actions), dependency-review.
- WIF condition restricted to `integration`/`main` refs.
- GitHub Environments: `staging` open; `production` approval-gated.
- Branch protection with the always-run required checks.

**PR-10** Verified model ladder + Vertex smoke.

**PR-11** One upload cap + `storage.rules`/`firestore.rules` in the repo (exported from live first), deployed by the workflow, with `firebaserules.admin` for the deployer.

**PR-12** Transcoder per-chunk fan-out: deterministic task names; skip chunks that already have an LRO; unknown duration → chunked.

**PR-13** Summarizer map-reduce + salvage (all templates + regenerate).

**PR-14** Embedder: batch, retry, fail loudly into the DLQ; delete dead `packages/db/src/embeddings.ts`; genai check covers `packages/db`.

**PR-15** Stuck-note sweeper, spend-cap defer + refund, Scheduler triggers.

**PR-16** Retire sync `process-audio`; entitlement preflight, reconciled metering, tester grant.

**PR-16b** Resumable `/v1/uploads` + rate limits.

**PR-16c `ops: observability + e2e`**
- Log-based metrics dashboard: failure rate, DLQ depth, p95 time-to-summary by duration, spend.
- Email alerts; uptime check on `/v1/health`; Error Reporting; `docs/SLO.md`.
- **e2e workflow:** nightly 10-minute fixture, and weekly or on-demand 3 h fixture, asserting transcript, chapters and embeddings rows under one `traceId`.

## Stage C — native iOS (PR-17…29)

- **17** `/v1` client:
  - three configurations: Debug (placeholder Firebase), Staging, Release;
  - **`AlgoMinutes-Staging` scheme** (archive = Staging);
  - Staging and Release builds fail without the plist;
  - dSYM upload for all configurations except Debug;
  - `X-AlgoMinutes-Client` header; 426 screen; transcript paging;
  - pin the newest Xcode in `ios.yml` and add `packages/contracts/**` to its paths.
- **18** Identifiers, entitlements, push: reversed client id; `algominutes://` scheme; App Group; `aps-environment`; FCM; ban `909388484461`.
- **19** Foundations + characterization tests:
  - `URLProtocol` mocks;
  - `os.Logger`;
  - service protocols;
  - actor instead of `nonisolated(unsafe)`;
  - strict concurrency `complete` (split into 19a/19b if > 600 lines).
- **20** Split `AppEnvironment` → `RecordingCoordinator`; split `APIClient` by domain with `Codable`; split `SettingsView` and the tests.
- **21** Brand:
  - "ai" mark icon: light opaque, dark transparent, tinted;
  - AlgoMinutes wordmark and gradient tokens (contrast ≥ 4.5:1);
  - launch screen;
  - rename `Owll*`;
  - drop Rajdhani and Splash;
  - sync `tokens.json`.
- **22** Crash-safe capture up to 4 h, chosen by measurement: continuity test; kill loses ≤ 1 segment; 4 h locked; segment format reused by PR-25.
- **23** Interruption, route, thermal and disk hardening.
- **24** Uploads that always finish (background resumable, size-scaled stall policy).
- **25** Broadcast extension: picker; App Group segment handoff; no Firebase in the extension; consent; review notes; kill-switch.
- **26** Pause + bookmarks (migration `014` via the PR-08b migrate job; contract regenerated; web updated; android deferred).
- **27** Live Activity (4th bundle id, App Group).
- **28** Follow-up sender + long-note seek.
- **29** Compliance & polish:
  - Sign in with Apple revocation via Firebase `revokeToken(withAuthorizationCode:)`;
  - String Catalog;
  - accessibility pass;
  - Privacy Report clean;
  - **XCUITest smoke on GitHub macOS**.

## Stage D — cloud release → **M1**

**PR-30 `build(ios): Xcode Cloud TestFlight`**
- **Spike first:** Xcode Cloud needs a project at workflow creation. If an XcodeGen project generated in `ci_post_clone` isn't accepted, commit the generated project and add a CI **drift check** that regenerates it and fails on any diff.
- `apps/ios/ci_scripts/ci_post_clone.sh`:
  - installs xcodegen and generates the project;
  - writes the per-workflow plist from a secret env var;
  - fails if the plist is missing.
- `ci_pre_xcodebuild.sh` sets `CURRENT_PROJECT_VERSION=$CI_BUILD_NUMBER`.
- Workflows:
  - **Staging → TestFlight internal:** scheme `AlgoMinutes-Staging`, triggered on `integration` with `apps/ios/**` changes, or manually;
  - **Release → TestFlight:** on `main`, used from Stage E.
- `scripts/asc-setup.mjs`; `.storekit`; paywall hidden behind a flag.
- `release.sh` kept as a GitHub-macOS fallback, with the ASC key held as an Environment secret.

**PR-31 `chore(ios): 1.0.0 (1)`** → **M1** on a real iPhone:
- 3 h locked-screen recording with a call mid-way;
- a broadcast-captured note;
- chaptered summary;
- one `traceId` end to end;
- minute-170 content found by search and chat;
- deleting the account removes the PG and Firestore rows and revokes the Apple token;
- the weekly 3 h e2e run is green.

## Production path after M1

**Stage E** (external TestFlight):
- PR-32 billing (Apple JWS x5c, ASSN, sandbox on prod);
- PR-33 diarisation + speaker chip;
- PR-34 single deletion path;
- **PR-35 prod environment:**
  - Terraform for `algominutes-prod`;
  - `deploy-production.yml` on `main` behind the approval-gated `production` Environment;
  - PITR + backup restore drill;
  - the first Release build via the Xcode Cloud Release workflow;
- PR-36 marketing/legal site.

**Stage F** (App Store): PR-37 captions · PR-38 calendar · PR-39 folders/search · PR-40 note detail · PR-41 DeviceCheck · PR-42 submission with phased release.

## Verification

| Gate | Proof |
|---|---|
| PR-08 | integration tests green on real Postgres; the isolation test fails under the mutation check |
| PR-08b | deploy log shows migrate → rollout order; smoke reports `schema_migrations` at head |
| PR-09 | a WIF token request from a non-integration branch is rejected (test workflow); `production` Environment requires approval |
| Stage B fixes | harness tests per fix; deploy smoke green; nightly 10-min e2e green |
| iOS PRs | GitHub macOS tests green on pinned Xcode; slow-expression check 0; strict-concurrency warnings 0 after PR-19 |
| PR-30 | an Xcode Cloud Staging build reaches TestFlight "Ready to Test" with no local archive |
| M1 | the PR-31 evidence list |

## Risks

- Your prerequisites gate everything; disk and the staging apply come first.
- Xcode Cloud + XcodeGen is handled by the PR-30 spike and fallback.
- The trial credit ends 14 Nov, which the budget alerts and the decision point in the runbook cover.
- The repo being public: gitleaks, CodeQL, Dependabot, ref-scoped WIF and key rotation mitigate it; revisit before launch.
- PR-22 and PR-25 are the hardest PRs; PR-25 is the top App Review risk (kill-switch kept).
