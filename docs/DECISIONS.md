# Decision log — AlgoMinutes

One line of reasoning per decision. Newest first within each phase. This file is the durable record of
choices made during the automated A2/A3 run so they are auditable from the git log.

## A11 — release engineering plan of record (2026-09-20)

The A11 plan is `docs/plans/A11-release.md`: a **strictly serial PR train** (one open PR at a time, one
concern each, evidence in every PR description) from first build to App Store. Decisions it rests on:

- **Apple identifiers and ASC key handling.** Team ID `NY9MS8GSBK` (ALGORYTHMOS PTY LTD., Organization).
  Release uploads authenticate with the App Store Connect API **team key** `457BNN593G`, issuer
  `6f9e67b0-fb28-401d-b347-2bd4ce854e2c`. Key id and issuer id are identifiers, not secrets; the `.p8`
  private key lives only at `~/.appstoreconnect/private_keys/` on the release machine (and later in a CI
  secret) and **never enters the repo**. Tooling reads `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_KEY_PATH`
  from env. Signing stays `Automatic` with `-allowProvisioningUpdates` — four bundle ids make manual
  profiles (the wasssup approach) not worth the upkeep.
- **Release tooling is ported from `wasssup-meeting`, not fastlane.** Its scripted `xcodebuild` +
  `asc-setup.mjs` flow shipped TestFlight builds 6→25; zero new dependencies, already debugged.
- **Build number resets to `1`.** `CURRENT_PROJECT_VERSION = 14` was inherited from the client app.
  AlgoMinutes gets a new ASC app record (`com.algorythmos.algominutes`), so there is no collision and no
  reason to carry another product's lineage. The release script refuses a build number ASC already has.
- **Broadcast extension ships wired in v1** (owner decision; supersedes the wire-or-exclude item in
  BLOCKERS §3). It is the top App Review risk, so `project.yml` keeps a switch that drops the targets.
- **Real IAP in sandbox from the first external beta** (owner decision). Internal builds hide paywall
  entry points behind a flag until Apple JWS verification is real. Production billing must honour
  `environment=Sandbox` transactions — TestFlight *and App Review* purchase in sandbox against the
  production build.
- **Staging for internal TestFlight; prod provisioned before any external tester** (owner decision), so
  real users' recordings never live in staging.
- **Recording cap is the plan entitlement (up to 4 h), delivered by crash-safe segmented capture.** The
  hardcoded 2 h cap and the single-`.m4a`-finalised-on-stop design are both replaced (plan PR-18); a
  crash may cost at most one segment, never the meeting. Recording is never blocked by being offline.
- **Never hold a recording hostage.** A recording that turns out to exceed remaining quota is still
  processed and readable; the *next* recording is what gets blocked, with an upgrade prompt. Metering
  reserves on the client's duration and reconciles to the server-probed duration.
- **Cloud NAT (third-party STT egress) is declared but off until diarisation go-live** (plan PR-28); its
  monthly cost is recorded here when enabled, per the "no service without its operating cost" rule.

## Cloud Run + Scheduler + WIF in Terraform; async config reconciled (2026-09-20, PR-06)

Terraform now creates the runtime, not just the platform:

- **7 Cloud Run services + a `db-job` Cloud Run Job**, each with a placeholder
  image and `ignore_changes` on the image tag so `terraform apply` stands them
  up before any image exists and the deploy pipeline owns the tag thereafter.
  Explicit per-service limits (transcoder `3600s / 2 GiB / 2 cpu / concurrency 1`
  for long audio; others modest), a `cloud_run_max_instances` cost cap, private
  VPC egress via the connector, and env wired from Terraform (project, buckets,
  per-stage queues, DB via a Secret Manager `PGPASSWORD` ref, and downstream
  service URLs via Cloud Run's deterministic `SERVICE-PROJECTNUMBER.REGION.run.app`
  hostname — which avoids a resource cycle between services).
- **Task-invocation identity `run-jobs`**: the OIDC SA Cloud Tasks carries; holds
  `run.invoker` on each service; api/transcoder/summarizer `actAs` it.
- **Keyless CI deploys**: a GitHub **Workload Identity Federation** pool scoped to
  `Algorythmos-AI/algominutes` + a `gha-deployer` SA — no JSON key ever created.
- **`activation_policy` is now managed** (default `ALWAYS`) — closes the
  2026-08-27 drift TODO: apply's effect on the paused DB is defined, and pausing
  is `db_activation_policy = "NEVER"` + apply rather than an out-of-band patch.
- **Cloud NAT** is declared behind `enable_nat` (default off); it turns on at
  diarisation go-live (PR-28) for third-party STT egress, cost recorded then.
- **Cloud Scheduler triggers are deferred to PR-13** (their handlers — retention
  enforcer, stuck-note sweeper — don't exist yet; creating cron for a missing
  handler would just fail).

Async config reconciled so code and infra agree (was: one `audio-jobs` queue in
code vs five stage queues in Terraform; DLQ write at attempt 5 vs queue
`max_attempts = 10`):

- Code enqueues to the **per-stage queues** (`transcode`/`summarize`/`embed`/
  `notify`) Terraform creates.
- **`task_max_attempts` (default 5) is the single source**: it sets the queue
  `max_attempts` and each service's `MAX_TASK_ATTEMPTS` env, which drives
  `isFinalAttempt` — so the DLQ write fires on the true last attempt.
- Every task gets a **1800s dispatch deadline** (the Cloud Tasks max) so a
  long-audio handler is never cut off by the queue.

Apply is gated on `gcp-admin` ADC and is a money-spending op — see the runbook
`docs/runbooks/resume-staging-and-deploy.md`. The module is `terraform validate`
clean; the recorded `plan` is produced by that authenticated apply.

## Staging paused to stop idle spend (2026-08-27)

Owner not working on the project; staging was billing 24/7 with no Cloud Run service deployed and no
traffic. Chosen action: **pause, keep all data** — explicitly *not* `terraform destroy`.

- **The VPC connector was DELETED, not scaled down.** `min_instances` floors at 2 e2-micro instances
  (`modules/environment/variables.tf`), which bill continuously regardless of traffic — the largest
  single idle line item. Deletion is the only lever that reaches zero. Safe because no Cloud Run
  service was attached (verified: `gcloud run services list` returned empty).
- **Cloud SQL stopped via `--activation-policy=NEVER`**, not deleted. Disk and existing automated
  backups still bill (single-digit dollars); compute does not.
- **Kept deliberately:** VPC, subnet, PSA range `algominutes-staging-psa` (INTERNAL/VPC_PEERING
  addresses incur no unattached-IP charge), buckets, Firestore, Secret Manager, service accounts.
  These are free-or-cents and make resuming fast.
- **Pre-pause export taken** to `gs://algominutes-staging-imports/backups/pg-pause-20260827-100654.sql.gz`
  — written to the *imports* bucket, never *recordings*, which has a 7-day delete lifecycle rule.
  **The dump is 450 bytes because the database is genuinely empty** (0 tables, 0 rows — verified by
  decompressing and reading it). Migrations were never run, consistent with Cloud Run never having
  been deployed. A byte-size threshold is therefore the WRONG validity check for this dump; check
  that it is a structurally complete `pg_dump` instead.
- **Cloud SQL service agent `p627101926311-q4gahs@gcp-sa-cloud-sql.iam.gserviceaccount.com` was
  granted `roles/storage.objectAdmin`** on the imports bucket to allow the export. Bucket IAM uses
  `google_storage_bucket_iam_member` (non-authoritative), so `terraform apply` will not strip it.
  The first export attempt failed with `storage.objects.create` denied — IAM propagation lag, not a
  misconfiguration; the retry succeeded.

### ⚠️ This is out-of-band drift — `terraform apply` resumes the spend

The connector is a declared resource, so a plan will show it must be recreated. `activation_policy`
is **not set anywhere in the module**, so whether the provider reverts the stopped database is
**unverified** — `terraform plan` could not be run because the Google provider authenticates via
Application Default Credentials (a separate store from `gcloud auth login`), and ADC on the build
machine is `skalaliya@gmail.com`, which lacks `storage.objects.get` on the state bucket. Capturing
the real drift requires `gcloud auth application-default login` as `gcp-admin@algorythmos.com`.
**TODO: run the plan and record the actual output here.**

### Resume

```
gcloud sql instances patch algominutes-staging-pg --activation-policy=ALWAYS
gcloud compute networks vpc-access connectors create algominutes-staging-vpc \
  --region=australia-southeast1 --network=algominutes-staging-vpc \
  --range=10.8.1.0/28 --machine-type=e2-micro --min-instances=2 --max-instances=3
```

`--range` + `--network`, **not** `--subnet`: the resource is declared with `ip_cidr_range`
(`modules/environment/main.tf`), and recreating it against a subnet leaves a permanent diff.

### Related: three other projects were also stopped

Not part of algominutes, but found running during this work and stopped with the owner's approval via
the existing `~/.local/bin/gcp-schedule.sh --force-down`: `wassup-meeting-pg` (wassup-meeting),
`voxtable-stg-postgres` (bp-voxtable-stg), `core-central-vm` (vocotable-497209, already TERMINATED).
The `com.sam.gcp-schedule.plist` launchd job was **unloaded** — it carries `StartInterval 1800` on top
of its weekday triggers, so it reconciles every 30 minutes and would otherwise have restarted
everything. **Re-loading that job, or running `gcp-schedule.sh` without `--force-down`, brings all of
it back up.**

## Diarisation — engine swap to AssemblyAI (ADR 0005, 2026-08-16)

Scoped run against `docs/plans/DIARISATION-PLAN.md`. Fixes Bug 17 (0 of 4,253 lines carry a speaker tag).
Approved build = plan option (c): **AssemblyAI primary, Deepgram as the failover seam**, Gemini fast-path
for short clips untouched.

- **Engine swap to a third-party whole-file diariser, NOT Google STT v1.** Chirp 3 (STT v2) diarisation is
  `us`/`eu` multi-region only — **not `australia-southeast1`** — and can't return word-level timestamps with
  diarisation on long audio; STT v1 gives diarisation+timings but is the most expensive tier and at
  A$0.024/min the Pro cap loses money. AssemblyAI (~A$0.005/min) is the only option that clears the A9.3
  pricing at the 1,500-min cap. The failover seam is **Deepgram**, not Google.
- **⚠️ Deepgram EXCEEDS Pro net revenue.** ~A$0.0096/min → ~A$14.40 for a 1,500-min Pro cap vs ~A$12.75 net
  revenue. Only AssemblyAI survives at the cap. Deepgram exists so a provider swap is a client change, not a
  pipeline change — it must NOT be switched on for the Pro tier without a pricing change. Recorded as a known
  failover cost per the plan.
- **Whole-file diarisation in one pass.** The provider diarises the entire recording, so speaker tags are
  GLOBALLY consistent (Speaker 1 = the same person start-to-end) and the old per-chunk chunk-boundary speaker
  problem disappears by construction. This property and the pre-cutover shadow eval are the two things the
  plan says must never be cut.
- **STT engine lives behind a seam** (`services/transcoder/src/stt-provider.js`, env `STT_PROVIDER`).
  Default stays **`google`** (legacy per-chunk path) as the shadow-eval baseline and the (a1) fallback until
  AssemblyAI clears the shadow eval; cutover is flipping the env, not a code change. Whole-file lines map to
  a neutral internal transcript shape so downstream (redaction → summariser → embedder) is provider-agnostic.
- **AssemblyAI RETENTION FINDING (residency obligation #1 — verified 2026-08-16 from primary sources).**
  Async audio is **processed-then-deleted by default** (deletion begins at 72h; TTL configurable down to 1h;
  uploaded audio deleted within 24–48h) — defensible. BUT AssemblyAI **trains on customer data BY DEFAULT**
  (opt-in default; you must opt out), and **free-tier accounts cannot opt out**. Two defences are wired in
  code: (1) we DELETE each transcript on the vendor right after persisting it to Postgres
  (`assemblyai.deleteRemote`), and (2) Deepgram requests set `mip_opt_out=true`. The **account-level
  model-training opt-out on a PAID plan** and an **executed DPA** are hard preconditions, tracked in
  BLOCKERS — not optional. Full evidence with quotes/URLs: `docs/audits/DIARISATION-VENDOR-RETENTION.md`.
- **Data residency: US processing ACCEPTED; storage stays `australia-southeast1`.** Audio egresses to the US
  for transcription (AssemblyAI primary US region; EU/Dublin exists as a seam but US is the decision). This
  makes the A10 store declarations' AU-only implication FALSE unless corrected — privacy policy, Play Data
  Safety, and Apple labels updated to state cross-border US processing + APP 8 overseas-disclosure wording.
- **Per-note speaker names for v1.** New `note_speakers(note_id, speaker_tag, display_name)` map + rename
  chip + `POST /v1/notes/:id/speakers`. Cross-note learned names are DEFERRED — they need voice embeddings
  and a voiceprint privacy stance we're not taking at launch (fast-follow with its own privacy note).
- **Rename UX cut to a fast-follow (plan's #2 cut); raw "Speaker N" ships now.** Diarisation itself is the
  P0 and now renders real speaker labels on iOS: the fix was that `NoteReadResponse.asTranscriptLine`
  rebuilt "Speaker N" from the tag and IGNORED the server-resolved `speaker` — so it now honours a
  note_speakers rename. The rename ENDPOINT + map + iOS `APIClient.setNoteSpeaker` are built and reachable;
  the interactive tap-to-rename chip (SwiftUI alert + optimistic reload) is deferred because it could not be
  compiled/device-tested in this session (no Xcode/simulator), and the plan lists it as the first thing to
  cut if time is short. **Web ships raw "Speaker N" with no rename**: the web transcript comes from the
  Firestore mirror (`{speaker, time, text}`, capped 200 lines) which carries no `speakerTag`, so a web chip
  needs the tags plumbed through the mirror or the web moved onto the API transcript read first — tracked in
  BLOCKERS. All iOS/web client edits here are UNBUILT in this session (no toolchain); flagged for review.
- **Cost figures are LIST prices.** A11 must measure the real blended COGS/min before `FREE_FLOOR_MINUTES`
  and the Pro included-minutes cap are fixed (ties to the open A9.4 / A9.3 items).
- **Operating cost of the change:** no new service (the engine swaps inside the existing transcoder Cloud Run
  service). New external dependency = AssemblyAI (primary) with Deepgram as a configured-but-off failover;
  both are per-minute usage, no standing cost. New egress surface (audio → US) requires the DPA + a VPC
  egress path to `api.assemblyai.com` (BLOCKERS).

## A10 — Launch blockers (diarisation skipped — its own scoped run)

- **Share links SHIP ON.** All four hardening requirements verified met: token stored as sha256 hash
  (plaintext `token` dropped, 006), `expires_at` NOT NULL, `revoked_at` + revoke path, robots.txt
  Disallow. The one real gap — the `/s/**` PAGE had no noindex (firebase.json has no headers block; the
  robots.txt comment claimed one that never existed) — was CLOSED: in-app `<meta robots noindex>` on the
  shared-note page (host-agnostic control), `apps/web/vercel.json` X-Robots-Tag on `/s/**`, and the API
  `/v1/shares/read` already sends X-Robots-Tag + no-store. Read path hashes the token, checks
  revoked/expiry, logs outcome to `share_access_log`.
- **Consent (conservative default + seam only).** v1.0 never auto-records; a per-session, plain-English
  pre-recording notice must be acknowledged; the recorder consults a single `ConsentGate` right after the
  permission check (iOS + Android), so the full layer swaps only the gate body — no recorder rewrite. The
  full jurisdiction/per-participant-log/audible-announcement layer is `TODO(legal)` and was NOT implemented
  or guessed (opinion not commissioned).
- **Store compliance.** PrivacyInfo/Apple labels/Play Data Safety declare analytics/tracking = NONE (the A6
  decision), not the default. Permission strings rewritten to specific what/why/where. Account deletion has
  TWO paths for now: the legacy Settings modal (Cloud Function) kept behaviour-preserving + the new public
  `/delete-account` page (Play-required) → `/v1/account/delete`; consolidate to one path later. Age
  ratings recommended (Apple 4+ pending UGC review, Play "Everyone"). Timestamped Terms+Privacy acceptance
  at signup (versioned).
- **Data retention.** User-set retention (`RETENTION_OPTIONS_DAYS` + keep-until-delete default); a stated
  30-day backup-propagation window (cap Cloud SQL PITR + Storage lifecycle ≤30d so deletion ages out rather
  than editing backups); local device audio purged only on confirmed upload. Enforcer job + backup config
  are `TODO(A11)`.
- **Store listing** = distribution: summary-first screenshot plan, keyword research, demo outline, ratings
  prompt after a viewed successful summary (never launch). Draft copy only; imagery `TODO(brand)`.
- **#7 trial anti-abuse (closes A9 fragility #1).** Server enforces: mobile needs a device-attestation hash
  (unused device → fresh trial; else free floor), web needs an account email. Client tokens: iOS DeviceCheck,
  Android Play Integrity (stub, no fake token). The attestation token's AUTHENTICITY verification is
  `TODO(A4-apple)/(A11)` — the server trusts the client hash for now.
- **Analytics events NOT extended** for support/terms/retention/deletion (the `AnalyticsEvent` enum lacks
  them; the A9.6 conversion funnel is complete). Adding those event names + emit calls is a small follow-up.

## DECIDED — A9.3 & A6.3 (2026-08-16)

- **A9.3 — REVERSE TRIAL** (not freemium, not a plain trial). Day 1–7: full features, **no card**, on web
  and mobile. After day 7: account drops to a thin **free floor** (habit-alive, not real work). **Pro
  A$14.99/mo**, annual ≈ two months free (**A$149.90/yr**). Rationale: reverse trials convert ~24% median
  vs ~4.5% freemium / ~14% opt-in trial; a perpetual free tier + a trial cancel out; competitors' generous
  free tiers (Otter 300 min/mo, Fathom unlimited) mean a free tier is not a differentiator for an unbranded
  product — the trial is. **`FREE_FLOOR_MINUTES` is DELIBERATELY UNSET** (config, loud TODO(A9-pricing)):
  it depends on blended COGS/min which A11 measures; shipping a guessed number risks an unbounded bill, so
  it **fails safe to 0 metered minutes until set**. Pro included minutes are config too.
- **A6.3 — GUEST MODE with anonymous→permanent upgrade.** No card + full features for 7 days means a user
  records and sees a summary before any account exists. Entitlement/ledger already key off a resolved uid
  that works for anonymous (Firebase anonymous auth) or permanent accounts — and Firebase
  `linkWithCredential` PRESERVES the uid, so upgrade loses no data and does not restart the trial. Prompt
  for the account **at the moment of value (after the first summary)**, never at launch.

  ⚠️ **Fragility flagged (see BLOCKERS):** no-account-for-7-days + anonymous means a reinstall with a fresh
  anonymous uid can restart the trial. Server keys the trial to uid; binding it to a durable device signal
  (iOS DeviceCheck/App Attest, Android Play Integrity) to stop reinstall-restart is a separate anti-abuse
  decision — a `trial_device_hash` seam column exists but is not enforced.

## A9.4 — App Review Guideline 3.1.3 (checked 2026-08-16)

- **Current rule:** external-purchase links / web-pricing CTAs are allowed **only on the US storefront**
  (no entitlement required there since 2025); other storefronts remain restricted, misleading price
  comparisons are prohibited, and a button that visually mimics an IAP button triggers the full disclosure
  flow. **Decision:** the **iOS paywall shows StoreKit pricing ONLY and never references web pricing**
  (AlgoMinutes ships globally from AU; the permissive rule is US-only). Revisit per-storefront if we later
  want to surface the cheaper web rail on iOS. Flagged to you rather than assumed.

## A7 — Reliability & async UX

- **A7.1 offline capture was already substantially built (§5); extended, not rewritten.** Added a durable
  per-recording upload state (`recorded→uploading→processing→ready→failed` + byte offset) to the
  `RecordingStore` sidecar and surfaced it in `PendingRecordingsView`. Local-first write, recovery-on-relaunch,
  and play-before-upload already held.
- **A7.2 resumable upload — additive new transport, NOT a §5 rewrite.** The inherited `UploadService`
  (Firebase `putFile`) does not do URLSession background transfers and restarts from byte 0 across launches
  — which A7.2 (the phase) explicitly requires. Rather than rewrite the working uploader, added a NEW
  `BackgroundUploadService` (URLSession background, chunked, persisted byte-offset, resume-after-reboot)
  against a new server **upload-session contract** (`POST /v1/uploads` → GCS resumable session), wired as
  the resumable path but **gated OFF by default pending on-device verification** (can't build/test here);
  Firebase `putFile` stays as the working fallback. This is the case for the change, made here per §5.
  Wi-Fi-only is a P1 settings toggle. **Android upload is B2** — it consumes the same upload-session contract.
- **A7.3 notifications — `services/notifier` is a NEW service.** Operating cost (§3.3): one async Cloud Run
  service (scale-to-zero, no idle floor) + the `notify` Cloud Tasks queue + one dashboard/alert; cost driver
  is FCM fan-out volume (cheap). Push permission is requested only AFTER the first recording (never at
  launch). Real APNs/FCM device registration is `TODO(A4-apple)` (needs the iOS Firebase app). Local
  notification is the fallback when push is declined; taps deep-link via `algominutes://note/<id>`.
- **A7.4 failure/quota integrity.** Refund-on-failure is a **reversal row** in `usage_ledger` (never a
  delete), appended on a worker's FINAL attempt. **Metering happens at ingest in the api process route**
  (before transcode is queued — A9.2, so we never pay for STT on over-quota work); the workers do the
  *refund*. **Embedder failure does NOT refund and does NOT notify** — the note is still readable without
  embeddings, so it's only dead-lettered. DLQ = a `dead_letter` table (Cloud Tasks has no native DLQ) with
  an admin view; workers write it on final attempt.

## A9 — Revenue layer (schema groundwork only)

- **Schema + repo only** (per instruction) — no StoreKit / Play / Stripe / paywall UI (those depend on the
  OPEN decisions above). `plans` + `usage_ledger` added; `subscriptions` extended with `source` (dual-rail
  seam, A9.4) + `trial_end` (A9.3 seam). Plan minute quotas are **config-authoritative**
  (`@algominutes/contracts` `PLAN_MONTHLY_INCLUDED_MINUTES`), mirrored by the `plans` table.
- **Entitlement is server-side** (`assertCanMeter`/`resolveEntitlement` over the ledger) — never trust the
  client; the `GET /v1/entitlement` endpoint exposes it read-only.

## A5 — Rename to AlgoMinutes

- **Renamed class-by-class, one commit per class** (iOS, Android, web+services+packages+.claude, docs) —
  no blind global sed, since `wassup` appears in bundle ids / package paths where a careless replace breaks
  signing/build silently. Each class independently verified (xcodegen for iOS, `google-services.json`
  package_name match for Android, grep-clean + invariants for web/services).
- **iOS:** `com.wassup.meeting`→`com.algorythmos.algominutes` (+ `.BroadcastExtension`/`.BroadcastExtensionSetupUI`),
  dir `Wassup/`→`AlgoMinutes/`, `WassupApp.swift`→`AlgoMinutesApp.swift`, keychain group + App Group →
  `…algominutes` / `group.com.algorythmos.algominutes`, module name `Wassup`→`AlgoMinutes`. `project.yml`
  only; xcodegen regenerates.
- **Android:** package tree `com/wassup/meeting`→`com/algorythmos/algominutes`, namespace+applicationId,
  action constants, app_name, channel ids, notification icon. `google-services.json` was already registered
  against `com.algorythmos.algominutes` — verified match, left untouched.
- **Backend domains:** `wassup-meeting.web.app` → `api.algominutes.com` (API) / `algominutes.com` (site) in
  iOS APIClient/LoginView and web `apiUrl.ts` (env-driven, `VITE_API_BASE_URL` wins). Domains not yet
  confirmed live — `TODO(A9-infra)`.
- **GCP project-id refs** in service deploy configs → `${GCP_PROJECT}` / `algominutes-dev` placeholders, not
  a hardcoded real id (per-env at deploy).
- **Provenance docs deliberately keep the source-repo name** (`skalaliya/wasssup-meeting`) and client
  identifiers being replaced — the verify grep's only remaining hits are those 6 docs; that is legitimate.

## A6.5 — Design system

- **Provisional AlgoMinutes palette + type scale** authored once in `packages/tokens/tokens.json` and applied
  to web (`index.css` `@theme`), iOS `Theme.swift`, and a new Android Compose theme (B2 foundation). Brand
  accent = indigo `#5B67F0` (distinct from the client's Apple-blue `#0A84FF`), refined dark neutral ramp +
  a light ramp, status colours, modular type scale, a11y baselines. **Kept the app's dark-first aesthetic**
  (a full light-mode wiring is a follow-up; the light ramp exists in tokens).
- **Client brand fonts (Rajdhani/Titillium) dropped** for a system font stack; **final hue, logo/wordmark
  art, and typeface are `TODO(brand)`** — no artwork generated, per instruction.

## A6.9 — Accessibility

- **Applied the safe, high-confidence fixes** (VoiceOver/ARIA labels on icon-only controls, one
  Dynamic-Type fix, 10 touch-targets to 44pt/px across iOS + web) and **flagged contrast/layout for design**
  rather than auto-changing brand tokens. Report: `docs/audits/A6.9-ACCESSIBILITY.md`.
- **Contrast recommendation (needs brand sign-off, tied to the TODO(brand) hue):** the provisional accent
  `#5B67F0` is 4.34:1 on the dark bg — **fine for large text/fills but below AA (4.5:1) for normal-size
  text/links.** Recommended fix when the brand hue is set: reserve the accent for large text/fills and add
  an `accentText` token (a lighter indigo, ~`#8B93F7`, ≥4.5:1 on `#0B0B10`); bump `placeholder`
  (`#5A5D6E`, 3.02:1) to ~`#6E7183`. Not applied now — the final palette is a brand decision.
- **Android TalkBack + Compose a11y deferred to B2** (no Compose app yet).

## A4 — Provision infrastructure (non-Apple)

- **Nothing was provisioned live** — the automated session's gcloud identity (`skalaliya@gmail.com`) has
  no access to `algominutes-staging`/`prod` (owned by `gcp-admin@algorythmos.com`). I did not authenticate
  as another account. Safe default: author everything apply-ready and hand the apply to a `gcp-admin` shell.
- **Infrastructure as Terraform, not imperative gcloud** (BUILD-PLAN §4.3). Idempotent, reviewable, one
  `terraform apply` per env. Structure: a reusable `modules/environment` + thin `envs/{staging,prod}` callers.
- **Cloud Run services are NOT in Terraform.** Their runtime service accounts, IAM, VPC connector and
  Artifact Registry are; the service *deploys* (build → push → deploy) are per-service in A11 (§3.3 "own
  deploy"). Terraform provisions the durable infra around them.
- **VPC + private IP + serverless connector included** — required by the invariant "Vertex AI only from
  Cloud Run behind the VPC connector; the public Gemini client does not work from there." Cloud SQL is
  private-IP only.
- **Staging tier differences** (mirror prod architecture at the smallest viable tier): Cloud SQL
  `db-f1-micro`/10GB, PITR off, `deletion_protection` off, 7-day recordings-bucket lifecycle, Firestore
  deletion allowed. **Prod:** dedicated `db-custom-1-3840`/20GB, PITR on, `deletion_protection` on, no
  recordings lifecycle. Both ZONAL to start (REGIONAL HA is a later prod hardening).
- **§4.6 circuit breaker fails OPEN on a meter-read error** — a broken cost meter logs loudly but does not
  halt the whole product; the sustained-outage backstop is the budget alerts + monitoring. Trip on a real
  over-cap read is hard (non-retryable). The spend reader is a stub (returns 0) until A9 wires
  usage_ledger/COGS, so the breaker is present-and-wired but inert now.
- **Budgets not managed in Terraform** — they already exist (INFRASTRUCTURE §4.4); recreating would
  conflict. The prod-budget re-scope stays a manual open item.
- **Firebase configs regenerated per env via the CLI** (runbook step 4), never copied from the client
  project, and never committed (git-ignored).
- **Staging is provisioned (15 Aug 2026).** `terraform apply` on `algominutes-staging` succeeded — 111
  resources live. Firebase enabled (Blaze), Google sign-in on, Web + Android apps registered; iOS app not
  registered (pending Apple Team ID). Prod is authored but not yet applied.
- **Web Firebase config lives in `apps/web/.env`** (git-ignored), read via `import.meta.env.VITE_FIREBASE_*`
  in `firebase.ts` and `VITE_API_BASE_URL` in `apiUrl.ts`. All 8 vars align with `.env.example` — no
  missing/extra. The apiKey is a public domain-restricted client key but is kept out of git and out of
  INFRASTRUCTURE.md; `.env` is the single place for it. Per-env values never shared (prod regenerates).
- **Firebase Analytics is deliberately OFF in the web client.** No `getAnalytics()` call exists; the
  config's `measurementId` is present but unused, so no analytics data is collected. Turning it on is an
  A10 decision (privacy policy + store Data Safety), not a default. Recorded so it stays a choice.
- **Cloud SQL `edition` pinned to `ENTERPRISE` (both envs), set in tfvars.** The first staging apply failed
  — Google now defaults new Postgres instances to `ENTERPRISE_PLUS`, which rejects shared-core tiers
  (`db-f1-micro`). Added a `db_edition` module variable (default `ENTERPRISE`, validated to the two allowed
  values), wired into `google_sql_database_instance.pg.settings.edition`, exposed as a root var in each env
  and set to `ENTERPRISE` in both tfvars (not hardcoded in the module). Prod's `db-custom-1-3840` is valid
  on either edition; `ENTERPRISE` is chosen to keep both envs consistent and avoid the pricier
  ENTERPRISE_PLUS default. Everything else in the first apply succeeded; re-apply creates only the SQL
  instance/DB/user.

## A6 — Generalise the product (credential-free parts)

- **A6.1 templates:** removed the client `clinical` template; kept `general` + `actions_only`; added
  `standup`, `interview`, `sales_call`, `lecture`, `one_on_one`, `board_meeting`, `client_meeting`. Every
  template reuses the flat `BASE_SCHEMA` (gist/actionItems/keyDecisions) — the structured-output invariant
  is preserved, not loosened (a template that added fields would be silently dropped by the tables, the
  Swift model, and the gemini-1.5-flash fallback). Canonical set in `@algominutes/ai`; mirrored to
  `packages/contracts` (enum + `SUMMARY_TEMPLATES` + openapi) and the iOS enum/tests. Web renders from the
  contract; Android is B2. This is a three-client contract change — openapi/model regen is deferred (no deps).
- **A6.2 recording cap:** replaced the hardcoded 2h cap + "Slater staff meetings" justification with a
  named, plan-derived config (`RECORDING_LIMITS`/`DEFAULT_MAX_RECORDING_SECONDS`/`maxRecordingSecondsForPlan`)
  in `@algominutes/contracts`. Kept 2h as the default-tier value to avoid a cost-affecting behaviour change;
  per-plan values are TODO(A9). Web imports it; iOS mirrors the constant (Swift can't import the TS const).
- **A6.7 strings:** stood up the string catalog (`packages/tokens/strings/en.json`, 57 strings) + typed
  `t()`/`strings` accessor now so i18n is not a three-client retrofit. **Template labels/blurbs are NOT
  duplicated in tokens** — they stay with the template set in `@algominutes/contracts`. iOS/Android consume
  generated `Localizable.strings`/`strings.xml` from the catalog; that codegen (json→platform) is TODO,
  same pattern as contracts models. The exhaustive per-file migration of every remaining hardcoded string
  is a tracked follow-up — the infra + a real shared catalog + web wiring are in place.
- **A6.4 / A6.6 delivered as audits** (`docs/audits/`), not implementation — the user scoped these as the
  audit passes. Onboarding/sample-note/permission-explainer building executes from the A6.4 audit later.
- **A6.6 safe copy fixes applied now** (the rest await A5/A8): (V1) the web "Record Online Meeting" card is
  filtered out on `platform === 'web'` — the read-only web client can't capture system audio, so it must
  not advertise it (ADR 0002); (V2) the web alert no longer claims online recording is "iOS only" (Android
  does it too); (V3) the iOS login tagline "…chat with every meeting" → "Record, transcribe, and get the
  minutes." (iOS ships mic-only). "Wassup Doc" naming left for A5.
- **iOS broadcast extension stays re-homed but MUST NOT ship unwired** (A6.6 N1). It is bundled
  (`apps/ios/BroadcastExtension`) yet no in-app UI triggers it (no `RPSystemBroadcastPickerView`), which a
  reviewer will question. Safe default: keep it in the repo (§5 protected asset); before the iOS
  submission build, EITHER wire it (`RPSystemBroadcastPickerView` + honest capture copy + the A4 App Group)
  OR exclude it from that build. Recorded in BLOCKERS — a decision for you, not resolved here (needs A4).

## A3 — Port, consolidate, contract

- **db-job folds into a scheduled Cloud Run job, not `api` (§3.2).** Its handlers (`eval-recall`,
  `debug-corpus`, `verify-phase-0`, `backfill-pr-d`) are batch/ops work, not user-request work; putting
  them behind the sync `api` surface would mix scaling profiles. Ported to `services/db-job` as a job
  entrypoint; client-specific backfill payloads dropped. Reversible: can be merged into `api` later.
- **Functions handlers consolidated into `services/api` as `/v1` routes (§3.1).** `note-read`,
  `export-note`, `search-and-chat`, `shared-note`, `delete-account` become Express routers under one
  auth path + one CORS config. Firebase Functions retained ONLY for genuine triggers (auth/Firestore) —
  none of the five was trigger-bound, so all five move. One HTTP surface achieved.
- **API is versioned from day one under `/v1` with a required `X-AlgoMinutes-Client` version header.**
  Unsupported clients get a friendly 426 "please update", never a 500. iOS/web ship before Android, so
  old builds must keep working — the version gate is additive, never breaking within `/v1`.
- **Contracts authored once in `packages/contracts` (zod) → OpenAPI → generated Swift/Kotlin models.**
  Never hand-write three copies. Generation is scripted so a contract change is a single-source edit.
- **`services/extractor` is a new Node service** wrapping `pdfjs-dist` / `mammoth` / `tesseract.js`
  (all permissive) + YouTube transcript extraction (ported from `transcoder/src/youtube.js`). Kills the
  JS-only client dependency so iOS/Android/web share one extraction implementation.
- **Token rename (wassup→algominutes) is NOT done in A3.** A3 is a structural port; the global rename is
  A5. Ported code still contains `wassup`/`com.wassup.meeting` until A5 runs — expected per the plan.
- **Redaction test fixtures use inline `# gitleaks:allow`, not a path allowlist.** Keeps `.gitleaks.toml`
  allowlist empty (§4.2) while letting synthetic fake secrets exist in tests without failing the gate.
- **ReplayKit broadcast extension re-homed into `apps/ios/BroadcastExtension` (+ SetupUI).** It lived in
  the Capacitor `ios/` target that we drop; the Swift logic is a §5 protected asset and was moved, not
  deleted (carry-forward from A1).
- **Android Capacitor plugin bridges replaced by a direct Kotlin interface** (`RecorderInterface`). The
  MediaProjection/ForegroundService cores (`RecordingService`, `BroadcastRecordingService`) were ported
  unchanged (§5 protected); only the `*Plugin.kt` Capacitor glue was replaced.
- **Android A3 scope = audio layer + interface only.** The full native Compose app (auth, UI, upload,
  paywall) is Track B / B2. A3 ports the recorder cores + a Capacitor-free interface so B2 starts from
  the hard part. `apps/android` is intentionally not a buildable app yet.
- **All of source `shared/` consolidated into `@algominutes/ai`** (incl. `pg-query`, `storage-paths`,
  `logger`, `cloud-tasks`), not split across db/ai. Reason: services resolve `shared/` at runtime via a
  flat `sharedRequire(name)`; one resolution root (`@algominutes/ai/<name>`) preserves that with a
  minimal edit instead of a per-name package map. `packages/db` = repo layer + migrations only.
- **Service Dockerfiles vendor the workspace packages** (`COPY packages/ai|db → node_modules/@algominutes/*`)
  replacing `COPY shared ./shared`. Full npm-workspaces build wiring is a TODO(build) for A11.
- **`services/api` runs under `tsx`** (no build step) because it imports `@algominutes/db` TypeScript
  source; mirrors the source's own `tsx server.ts`. A compiled build is an A11 concern.
- **API surface uses clean `/v1/...` names with the body contract preserved** (noteId/workspaceId in the
  JSON body), NOT `/v1/notes/:id` path params — path params would change what clients send.
- **Web keeps client-side extraction (pdfjs/mammoth/tesseract) for now**; switching the web to call
  `services/extractor` is a follow-up. A3's P0 was that the shared service exists.
- **Web Capacitor calls resolved via web-safe shims** (`apps/web/src/lib/native-shim/*`) rather than
  deleting App.tsx's native branches now — full web de-Capacitor + generalisation is A8. This keeps the
  repo free of any `@capacitor` dependency while being honest that A8 work remains.
- **Web Firebase config reads Vite env vars** (`apps/web/.env.example`) instead of importing the
  committed per-project JSON (which is git-ignored / regenerated at A4).
- **Branding + design tokens deferred to A6.5, i18n strings to A6.7.** iOS/Android brand assets and the
  web `@theme` block are kept as neutral placeholders with `TODO(brand)` so the apps still render; real
  values come from `@algominutes/tokens`.
- **Firestore `onNoteDeleted` stays a Firebase trigger** (genuine `onDocumentDeleted`); everything else
  HTTP moves to `services/api`. The six extra HTTP handlers in `functions/index.js`
  (processIntelligence, regenerateSummary, shareCreate, shareRevoke, noteFeedback, clientError) are being
  ported into `services/api` to complete the one-surface goal (§3.1).

## A2 — Repository foundation

- **`main` is not pushed and branch protection is not enabled during this automated run.** Reasoning:
  branch protection with required PRs would block the per-unit commits this run makes, and the first
  push is an outward action better taken by a human after reviewing the full port via `git log` — also
  the source-side Gemini-key rotation (EXTRACTION-AUDIT §5) is still pending. Remote is configured
  locally; push + protection are listed for the human in BLOCKERS. Reversible: nothing left the machine.
- **npm workspaces (no Turborepo yet).** §3.4 says add Turborepo only if build times justify it; they
  don't yet. Workspaces cover `packages/*`, `services/*`, `apps/web`; native `apps/ios` and
  `apps/android` are not npm workspaces.
- **`.gitleaks.toml` ships with an empty allowlist**; Firebase per-project configs are git-ignored and
  regenerated per environment (A4), so nothing needs allowlisting.
- **Proprietary `LICENSE`** (all rights reserved, © 2026 Algorythmos Pty Ltd) — the source had none; not
  carried forward.
