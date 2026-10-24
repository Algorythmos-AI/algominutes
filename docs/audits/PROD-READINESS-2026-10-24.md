# Production launch-readiness audit: backend and operations (2026-10-24)

> Read-only audit at `origin/integration` 6ce9c3f0 (2026-10-07), for plan rev 12 (`docs/plans/RELEASE.md`
> R12). Its findings carry the rev 12 ids (S*, O*). Line numbers are from that commit. Nothing was changed; no
> state-changing gcloud or terraform command ran. The iOS half is `APP-REVIEW-2026-10-24.md`.

## Verdict

**Not ready for a public App Store release, for operational reasons, not code.** The application layer meets
CLAUDE.md's bar: one auth path with Firebase ID-token verification on every `/v1` route except four deliberately
public ones, explicit `workspace_members` tenancy joins, strict CSP + CORS allowlist + a 426 `please_update`
client-version gate, verified Stripe/Apple/Recall webhook signatures, offline JWS chain verification for
StoreKit 2 with sandbox accepted, an hourly App Store reconcile, upsert or replace-in-transaction on every async
write, 10-minute chunking with claimed speech-to-text jobs, a dead-letter table with an admin view and an alert,
and an alert set covering every row of `docs/SLO.md`. All six invariant scripts, typecheck and 938 unit tests
pass. **But production does not exist**: the prod Terraform root is authored and never applied (the prod project
has the Cloud Run, Cloud Tasks and Secret Manager APIs disabled and no tfstate bucket), there is no
deploy-from-`main` workflow on any merged branch, `main` is far behind, and the prod-only secrets (App Store
Server key, DeviceCheck key, Stripe keys, alert e-mails, admin uids) are unset. Since 2026-10-20 the summarizer
runs on a single Gemini model whose Sydney capacity was already saturating at near-zero staging traffic, with no
quota or throughput increase recorded. No load test has run, no restore drill is recorded, and there is no
production incident runbook. Alert delivery is e-mail only.

## Blockers

| Id | Item | Finding | Evidence |
|---|---|---|---|
| O1 | Production environment does not exist | Prod Terraform root authored, never applied. Read-only gcloud (2026-10-24): `algominutes-prod` is ACTIVE, but `run.googleapis.com`, `cloudtasks.googleapis.com`, `secretmanager.googleapis.com` are not enabled; `gcloud sql instances list` is empty; the only bucket is `gs://algominutes-prod-switch-state` (no `algominutes-prod-tfstate`). | `infra/terraform/envs/prod/main.tf:98-146`, `envs/prod/backend.tf:8-13`, `docs/INFRASTRUCTURE.md` §4.5, `docs/plans/RELEASE.md` prod-ready section |
| O1 | No deploy-to-production workflow on `main` | `deploy-staging.yml` triggers only on `integration` (`:42-44`; every job `environment: staging`). `deploy-production.yml` exists only on the unmerged branch `ci/deploy-production` (e335e107, 2026-09-30, +388 lines). `promotion-guard.yml` and `terraform.yml` only validate. | `.github/workflows/deploy-staging.yml:5-7,41`; `docs/BLOCKERS.md` "Not landed" |
| S2 | Single Gemini rung, capacity unverified | `gemini-2.5-flash` retired 2026-10-20 and is dropped by `activeLadder()`; the ladder is `['gemini-3.5-flash']` (chat's "next model" is the same model). Before the retirement staging logged 9 `gemini_transient`, 5 `gemini_timeout`, 1 `gemini_model_exhausted` and 3 failed chats in a day at near-zero traffic; a deploy failed on two 240 s model hangs. The docs say a quota or provisioned-throughput request is the owner's to make and that the cause (project quota vs shared capacity) was not checked. No record it was done. | `packages/ai/src/models.cjs:39-41,58,66-69,85-89`; BLOCKERS 2026-10-06/07; `docs/DECISIONS.md` S1; mitigations: the summarize queue's 10 attempts × ≤ 600 s (`modules/environment/main.tf:397-412`), alerts `gemini_transient` and `gemini_model_unavailable` (`alerting.tf:103-113`) |
| O1 / S12 | Prod billing and entitlement secrets and switches unset | `db_password`, `recall`, `devicecheck_key`, `app_store_server_key` are declared (`cloud-run.tf:251-309`) but prod versions are owner steps; the Apple reconcile "does nothing until it's set" (`services/billing/src/env-spec.cjs:8-9`). **Stripe keys are not provisioned by Terraform at all** (a comment at `cloud-run.tf:157`; `env-spec.cjs:11 required: []`; `services/billing/src/lib/stripe.js:43` `TODO(A11)`), so prod Stripe webhooks answer 503 (`stripe.js:46-50`). `trial_on_first_use = "off"` and `admin_uids = []` in prod (`envs/prod/main.tf:58-61,140-143`). | as cited |

## Gaps

| Id | Item | Finding | Evidence |
|---|---|---|---|
| O4 | Alerts e-mail only; prod has zero channels until `TF_VAR_alert_emails` | The only channel type is `email`; `alert_emails` defaults `[]`. No paging or SMS. | `alerting.tf:240-248`; `envs/prod/main.tf:47-52` |
| O4 | SLO targets never revisited for prod; no API latency alert; no distinct Gemini 429 alert | `SLO.md:3` "Revisit them with real traffic before production." p95 latency is a dashboard tile only; `gemini_transient` folds 429 and 503. | `docs/SLO.md:3,8-15`; `monitoring.tf:219`; `alerting.tf:103-107` |
| O5 | Load test never run; spike capacity unverified | `scripts/load-staging.mjs` (#411) "Not run… the owner's call". Prod: api 4 instances × concurrency 80 (fine for ~100 users) but transcoder 4 × 1 = 4 concurrent chunk dispatches (the queue's dispatch cap, `main.tf:457-467`), summarizer 2 × 4, `min_instance_count = 0` everywhere. Cloud SQL `db-custom-1-3840`, ZONAL, 100 connections. 100 simultaneous recordings queue behind 4 transcoders and miss SLO 4; `queue_backlog` (> 50 for 15 min) and `sql_saturation` alerts exist. | BLOCKERS #411; `envs/prod/connection-budget.json`; `cloud-run.tf:28-38,186-189`; `main.tf:182` |
| (pass) | The PG_POOL_MAX lesson is encoded | The connection budget is enforced three ways (a Terraform precondition `main.tf:160-166`, `tests/connection-budget.test.ts`, CI with every pool capped at 1). Prod's worst case fits 100; api 2 pools × 5 per instance. | `docs/DECISIONS.md:550-560`; BLOCKERS |
| O6 | Restore drill: runbook exists, no recorded execution | `restore-drill.md` §4 says to record it in BLOCKERS; nothing recorded. | `docs/runbooks/restore-drill.md:65-69` |
| O7 | No Firestore backup; Cloud SQL ZONAL | No `google_firestore_backup_schedule`. Documented as acceptable (the cache is rebuilt from Postgres; mirror repair #408) but not a recorded decision. ZONAL = no HA. | `restore-drill.md:73-75`; `main.tf:182,470-476` |
| O6 | No production incident runbooks | 11 runbooks; rollback only for the Vercel site (`site.md:278-291`) and "never roll back below the TLS change" (`resume-staging-and-deploy.md:203-208`): no Cloud Run service-rollback procedure; no on-call or paging; no status page; the support inbox has an alert (`support_request_created`, `alerting.tf:231`) but no runbook; no "production is down"; no "a user's note is stuck" (only `SLO.md:15` and the `doc` strings per alert). | `docs/runbooks/` |
| S13 | Session and revocation check off | `verifyIdToken(token)` without `checkRevoked`; the compensating `SESSION_CHECK` is off until the owner applies `reviewed-dd556da5.tfplan`. | `services/api/src/middleware/auth.js:39,49`; BLOCKERS #413 |
| O6 | Tenancy proven in code, not by CLAUDE.md's two-account test | `note-read.cjs:152-164` joins `workspace_members` with an explicit `workspace_id`; 15 references in `packages/db/src`. No two-account evidence in BLOCKERS. | `services/api/src/routes/note-read.cjs:140-164`; `packages/db/src/workspace-access.ts` |
| S4 | Upload hygiene | Nothing bounds the bytes of an upload in progress; an oversized never-completed upload stays in the bucket (prod `recordings_lifecycle_days = 0`). | BLOCKERS #409 audit; `services/api/src/routes/uploads.js:98-100,284-294` |
| (note) | The dead-letter path is application-level; the admin view is locked in prod | Cloud Tasks has no native DLQ; a `dead_letter` row is written on the final attempt; if that write fails the failure is a log line, alerted (`dead_letter_record_failed`). `ADMIN_UIDS` gates the view; prod `admin_uids = []`. | `packages/db/migrations/007_billing_usage_dlq.sql:58`, `027_dead_letter_once.sql`; `alerting.tf:167-191`; `services/api/src/middleware/admin.js:12` |
| O9 | Docs drift | `docs/EXTRACTION-AUDIT.md:238` said the fixtures are allowlisted in `.gitleaks.toml` (the allowlist is empty); `docs/INFRASTRUCTURE.md:169` said staging paused while it is live. Both fixed with plan rev 12. | as cited |
| (note) | No `lint` script | `npm run lint` → `Missing script: "lint"`; the gates are `typecheck`, `test`, `invariants`, `gitleaks`. | root `package.json` |

## Passes

- **Queues:** 6 Cloud Tasks queues, no Pub/Sub; `max_attempts` 10, `min_backoff 5s`, `max_backoff 600s`,
  `max_doublings 4`, no time cap (`main.tf:396-440`); services get `MAX_TASK_ATTEMPTS` = the queue value so
  `isFinalAttempt` dead-letters on the true last attempt (`cloud-run.tf:54,125`; `packages/db/src/note-terminal.cjs`);
  admin view `GET/POST /v1/admin/dead-letters[/:id/resolve]` (`services/api/src/routes/index.js:255-256`); alerts
  `dead_letter_recorded` (any) and `queue_backlog` (`alerting-pipeline.tf:109-116`); dashboard tiles `queue_depth`
  and `dead_letters` (`monitoring.tf:196-219`).
- **SLO ↔ alerts:** SLO 1 → `api_uptime` (`monitoring.tf:14-82`); SLO 2 → `http_5xx` > 5 in 5 min
  (`alerting.tf:315-349`); SLO 3 → `note_failed`; SLO 4 → `time_to_summary_slo_missed`; SLO 5 →
  `dead_letter_recorded`; SLO 6 → `storage_purge_stuck`, `delete_account_incomplete` (`alerting.tf:20-235`). Extras:
  billing and site uptime, `sweep_absent`, `scheduler_failed`, `sql_saturation` (CPU > 80%, connections over
  threshold), budget thresholds (`budget.tf:19-51`), `gemini_output_truncated`, `spend_cap_*`, the Apple and Stripe
  reconcile alerts, 30-day log retention (`main.tf:667-671`).
- **API hardening:** helmet CSP `default-src 'none'` (`services/api/src/app.js:28-33,54`); exact `trust proxy`
  hops; CORS allowlist from `ALLOWED_ORIGINS` (`envs/prod/main.tf:136`); `express.json({ limit: '1mb' })`; IP 300 a
  minute and user 120 a minute on every authed route, chat 60 an hour and 200 a day, search 300 an hour, redeem 10 an
  hour (`packages/ai/src/rate-limit.cjs:42-92`); `/events`, `/process`, `/uploads*`, `/chat` all authed; only
  `/health`, `/health/ready`, `/shares/read` (the token is the credential, IP-limited), `/account/delete`
  (self-verifies) and `/client-error` (a beacon) sit outside `authMiddleware` (`routes/index.js:77-256`); the 500 MB
  audio cap (`packages/ai/src/intelligence.cjs:5`); the per-plan duration cap at the kickoff, free 2 h and pro 4 h
  (`packages/db/src/kickoff.ts:308-313`, `packages/contracts/src/limits.ts:11-14`); Stripe `constructEvent` on the
  raw body (`services/billing/src/lib/stripe.js:46-55`); Apple JWS ES256 with the x5c chain to the pinned Apple Root
  CA G3, marker OIDs and a bundle-id assertion (`services/billing/src/lib/apple.js:9-26,75-110`); Recall HMAC with
  Secret Manager secrets (`services/meetings/src/lib/recall-signature.js:41-65`).
- **App Store billing on the server:** `jwsRepresentation` verified server-side; Production **and Sandbox** both
  entitle and are logged (`services/billing/src/routes/verify.js:38-65`); the entitlement upsert goes through the
  repo (`verify.js:114`; `packages/db/src/subscriptions-repo.ts`, `entitlements.ts`); the App Store Server
  Notifications v2 endpoint `services/billing/src/webhooks/apple.js` (environment logged; DID_RENEW / EXPIRED /
  REFUND → `setSubscriptionStatus`); the hourly reconcile `tasks/reconcile-apple.js` via Cloud Scheduler
  (`scheduler.tf:255-270`), App Store Server API Production then Sandbox (`lib/app-store-server.js:7-8,152`);
  alerts `apple_reconcile_failed`, `apple_server_api_unauthorized`. iOS Pro is StoreKit; web is Stripe test mode.
- **Idempotency and long meetings:** `summaries ON CONFLICT (note_id) DO UPDATE` (`packages/db/src/notes-repo.ts:223-226,750-753`;
  `pipeline-repo.cjs:421-424`); chunked `transcript_lines ON CONFLICT (chunk_id, idx) DO NOTHING`
  (`pipeline-repo.cjs:333-335`); embeddings, action items, key decisions and legacy lines are DELETE-then-INSERT
  inside one transaction (`embeddings-repo.cjs:47-53`, `notes-repo.ts:231-250`); `dead_letter` unique per piece
  (027); 600 s chunks with 30 s overlap (`services/transcoder/src/route.js:7,20-27`); speech-to-text jobs claimed so
  a retry polls instead of paying again (`handler.js:393`, migration 036); the transcoder at 1800 s and concurrency
  1, the summarizer at 900 s, the dispatch deadline 1800 s (`packages/ai/src/cloud-tasks.cjs:31-36`); the summarizer's
  `responseSchema` with 65,536 tokens when chapters are asked for, and partial-JSON salvage
  (`services/summarizer/src/handler.js:25,237-245`); the 240-minute e2e passed (run 37189798506: 30 chapters, ready
  in 384 s).
- **Durability, prod as authored:** backups on, PITR on, 7 days of transaction logs, 7 retained backups, double
  deletion protection, SSL `ENCRYPTED_ONLY` (`main.tf:146-219`); versioned buckets with a noncurrent lifecycle inside
  the 30-day window, prod recordings never auto-deleted (`main.tf:356-386`); staging confirms the module live:
  `algominutes-staging-pg` RUNNABLE, backups on, PITR on, 7 days.
- **Client version gate:** `X-AlgoMinutes-Client` → 426 `{ error: 'please_update', message: 'Please update
  AlgoMinutes to continue.' }`, floors from `packages/contracts/src/version.ts`
  (`services/api/src/middleware/client-version.js:1-28`; `app.js:40-45,65-69`).
- **Secrets:** the four `git grep` hits for key-shaped strings are fixtures with no real credential
  (`docs/EXTRACTION-AUDIT.md`, `tests/integration/billing-stripe.test.ts:51`,
  `tests/integration/stripe-cancellations.test.ts:42`, `tests/redaction.test.ts:52`); `gitleaks detect --no-git`
  over the tree: no leaks; `.gitleaks.toml` is `title` + `[extend] useDefault = true` (an empty allowlist);
  `.gitleaksignore` holds one fingerprint (`monitoring.tf:146`), recorded in `docs/DECISIONS.md:311`; runtime
  secrets via `secret_key_ref` (`cloud-run.tf:231-233,291-293`); Firebase configs git-ignored.

## Quality gates, verbatim (origin/integration 6ce9c3f0)

```
npm run -s typecheck                      clean (3.9 s)
npx vitest run --config vitest.config.ts  Test Files 92 passed (92)  Tests 938 passed (938)  9.68 s
scripts/check-migrations.sh               warn gaps in numbering at: 31 35; ok no empty migrations; Migration integrity OK
scripts/check-no-console.sh               OK: no stray console.* in server dirs.
scripts/check-no-cors-true.sh             OK: no 'cors: true' wildcard CORS.
scripts/check-no-direct-firestore.sh      OK (312 files, syntax-aware)
scripts/check-no-genai-import.sh          OK: no public @google/generative-ai imports in services/shared.
scripts/check-no-silent-catch.sh          OK (361 files, syntax-aware)
node scripts/check-declared-deps.mjs      OK: every workspace declares the packages it imports.
npm run -s test:node                      tests 7, pass 7, fail 0
```

`tests/integration/**` (Postgres), `tests/rules/**` (the emulator) and `tests/site/**` were not run in the audit;
the invite test's failure (S1) was reproduced and fixed separately (#428).

## Not verifiable from the repo, and how to

1. Prod GCP beyond API enablement: `gcloud services list --enabled --project algominutes-prod`,
   `gcloud storage ls --project algominutes-prod`, `gcloud sql instances list --project algominutes-prod`.
2. The GitHub side of the deploy path: the `production` Environment, `GCP_WIF_PROVIDER` / `GCP_DEPLOYER_SA` and
   the deploy variables, the required checks on `main` (`gh api repos/<owner>/algominutes/environments`,
   `gh variable list`).
3. Gemini quota vs shared capacity: the Vertex quota page for `gemini-3.5-flash` in `australia-southeast1`, and
   whether a quota or provisioned-throughput request was filed.
4. The two-account tenancy test: accounts A and B on staging; A asks for B's `noteId` via `/v1/notes/read`,
   `/v1/search`, `/v1/chat`, `/v1/export`; expect 403 or empty.
5. Budget notification channels: `budget.tf:51` uses `var.budget_notification_channels`; the prod value.
6. Load at about 100 concurrent users: `LOAD_CONFIRM=run node scripts/load-staging.mjs` (about A$22.50).
7. The restore drill: `docs/runbooks/restore-drill.md` on staging, recorded; again on prod after Apply P.
8. The owner's consoles: Vercel Production and `APP_ENABLED`, the prod Apple Services ID return URL, the prod
   Recall account, the APNs key, the App Store Server API key.

## What has to happen for production to exist and take traffic

1. Bootstrap `gs://algominutes-prod-tfstate` (`envs/prod/backend.tf:8-13`); export `TF_VAR_billing_account`,
   `TF_VAR_alert_emails`, later `TF_VAR_admin_uids`; `terraform init / plan / apply` in `infra/terraform/envs/prod`.
2. Populate the prod Secret Manager versions (`recall`, `devicecheck_key`, `app_store_server_key`); decide and wire
   the Stripe keys (not in Terraform at all today).
3. Prod Firebase per `docs/runbooks/prod-firebase-config.md` (Blaze, Anonymous / Google / Apple, the iOS, web and
   Android apps, the APNs key, the prod plist into the Xcode Cloud Release workflow).
4. Rebase and merge `ci/deploy-production`; create the `production` GitHub Environment and its variables; make
   `promotion-guard` and CI required on `main`.
5. The promotion PR `integration → main` (P3): migrate, the waved rollout, the Vertex smoke, the authenticated
   smoke; then the prod restore drill, `session_check = "on"`, `trial_on_first_use` once DeviceCheck is configured,
   and the re-scoped `algominutes-prod-budget` (`docs/INFRASTRUCTURE.md` §4.3).
6. Before the public launch: Google's answer on gemini-3.5-flash quota or throughput in Sydney, the load test,
   alert channels beyond e-mail, and the incident runbooks.
