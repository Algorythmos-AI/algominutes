# Runbook — GCP provisioning (A4, non-Apple)

How to take AlgoMinutes infrastructure **live** per environment. Everything here is authored as
apply-ready Terraform (`infra/terraform/`) plus the manual Firebase steps Terraform can't do. It was
**not run** in the automated session — the session's gcloud identity (`skalaliya@gmail.com`) has no access
to the org projects. Run it from a shell authenticated as the org admin.

> **No secrets in git.** Terraform stores a generated DB password in Secret Manager; the runtime reads it
> via the service account. Never commit `.tfstate` (it contains that password) — the GCS backend keeps it.

## 0. Prerequisites

```bash
gcloud auth login algorythmos.france@gmail.com --no-activate   # primary working account (owner decision 2026-09-25)
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token --account=algorythmos.france@gmail.com)   # Terraform auth, ~1 h
# org-level work (Cloud Identity, org policies) still needs gcp-admin@algorythmos.com
terraform version   # >= 1.9 ;  gcloud >= 500 ;  firebase --version >= 15
```
Confirm access: `gcloud projects describe algominutes-staging` should succeed.

## 1. One-time state-bucket bootstrap (per env)

Terraform's GCS backend needs its state bucket to exist first (chicken-and-egg). Create once:

```bash
for env in staging prod; do
  proj="algominutes-$env"
  gcloud storage buckets create "gs://algominutes-$env-tfstate" \
    --project="$proj" --location=australia-southeast1 \
    --uniform-bucket-level-access --public-access-prevention
  gcloud storage buckets update "gs://algominutes-$env-tfstate" --versioning
done
```

## 2. Terraform apply — staging first, then prod

```bash
cd infra/terraform/envs/staging
# Required for the per-environment budget; never committed (public repo):
export TF_VAR_billing_account=$(gcloud billing projects describe "$(basename "$PWD" | sed 's/^/algominutes-/')" \
  --account=algorythmos.france@gmail.com --format='value(billingAccountName)' | sed 's#billingAccounts/##')
# Who the alerts email (alerting.tf); never committed. Empty = console only:
export TF_VAR_alert_emails='["you@example.com"]'
terraform init                       # uses the gcs backend from step 1
terraform plan -out=tfplan           # REVIEW the plan before applying
terraform apply tfplan               # Cloud SQL creation takes ~10 min
```
Repeat in `infra/terraform/envs/prod` (re-export `TF_VAR_billing_account` there, since the command derives the
project from the directory name). **Review each plan** — prod has `deletion_protection` on and a
Firestore location that is **permanent** once created.

This provisions (both envs, `australia-southeast1`): APIs, a VPC + serverless connector + private services
access, Cloud SQL Postgres (private IP), the `algominutes` DB + a Secret-Manager-stored password, the
three buckets (staging recordings = 7-day lifecycle), the five Cloud Tasks queues, a Firestore database,
an Artifact Registry repo, the seven per-service runtime service accounts + IAM, and the seven Cloud Run
services + the `db-job` Cloud Run Job with a placeholder image (the deploy workflow builds and rolls out the
real images), the GitHub WIF pool + deployer SA, the Scheduler jobs and the Firestore rules release.

## 3. Firestore mode + Firebase Auth (console / CLI — not Terraform)

- Terraform creates the Firestore **database**; enable the sign-in providers in the Firebase console →
  Authentication: **Anonymous** (the iOS app signs in anonymously at launch; without it the app falls back
  to the login screen), **Google** and **Apple**. Sign in with Apple's token revocation also needs the
  Apple provider's Services ID, Key ID and `.p8`.
- Terraform releases the repo's `infra/firebase/firestore.rules` (`firebase-rules.tf`). There is no
  `storage.rules`: recordings live in the api's own bucket, reached only through `/v1/uploads` and signed
  URLs (DECISIONS).

## 4. Firebase app configs — REGENERATE per env, never copy the client's

For **each** project (`algominutes-staging`, `algominutes-prod`):

```bash
firebase use algominutes-<env>
# iOS app
firebase apps:create ios "AlgoMinutes iOS" --bundle-id com.algorythmos.algominutes
firebase apps:sdkconfig ios <APP_ID> --out apps/ios/AlgoMinutes/Resources/GoogleService-Info.plist   # gitignored
# Android app
firebase apps:create android "AlgoMinutes Android" --package-name com.algorythmos.algominutes
firebase apps:sdkconfig android <APP_ID> --out apps/android/app/google-services.json            # gitignored
# Web app
firebase apps:create web "AlgoMinutes Web"
firebase apps:sdkconfig web <APP_ID>       # copy the values into the web env (below)
```
Put the web config values in the web build env (public, domain-restricted keys — see
`apps/web/.env.example`): `VITE_FIREBASE_API_KEY`, `_AUTH_DOMAIN`, `_PROJECT_ID`, `_STORAGE_BUCKET`,
`_MESSAGING_SENDER_ID`, `_APP_ID`, `_MEASUREMENT_ID`. Keep staging and prod values separate (per-env `.env`
/ CI env). **None of these config files are committed** (`.gitignore` covers them).

## 5. Secrets (Secret Manager, per env)

- **DB password** — created by Terraform (`algominutes-<env>-db-password`). Nothing to do.
- Any third-party keys (Stripe, etc.) — add as you wire A9: `gcloud secrets create … && … versions add`.
- Vertex AI + STT use the service accounts' workload identity — **no API key** (CLAUDE.md: Vertex only from
  Cloud Run; the public Gemini client is banned).

## 6. Migrations (the deploy runs them)

Every deploy runs `JOB_NAME=migrate` in the `db-job` Cloud Run Job, inside the VPC, before any
service rolls out, and fails unless the database ends at the migration head on disk
(`deploy-staging.yml`, runbook `resume-staging-and-deploy.md` §2). Nothing to run by hand.
The manual fallback, over the Cloud SQL Auth Proxy or from the bastion:
```bash
DATABASE_URL="postgres://…" npm run migrate      # applies every numbered migration up to the head
```
Migration `000_extensions.sql` runs `CREATE EXTENSION vector` (pgvector is a supported Cloud SQL extension).

## 7. Post-apply verification (BUILD-PLAN "Verify")

- [ ] `gcloud sql instances describe algominutes-<env>-pg` — RUNNABLE, private IP only.
- [ ] Buckets exist; staging recordings bucket shows the 7-day lifecycle rule.
- [ ] Five Cloud Tasks queues exist per env.
- [ ] **Backup restore test (§4.7):** restore a Cloud SQL backup into a throwaway instance at least once.
- [ ] **Spend circuit breaker (§4.6):** in staging, set `DAILY_SPEND_CAP_AUD` below the last 24 hours'
      paid audio × `COGS_AUD_PER_MINUTE` (the reader: `packages/db/src/spend-repo.cjs`, over `usage_events`),
      kick off a recording, and confirm the transcoder answers `{ ok: false, reason: 'spend_cap' }`, the note
      shows "We've reached today's processing limit", its minutes come back as a `refund:spend_cap` reversal,
      and no speech job starts. Then restore the cap. (DECISIONS "Spend cap".)

## 8. Open items carried from INFRASTRUCTURE.md

- Re-scope `algominutes-prod-budget` from the whole billing account to the prod project only.
- Staging deploys run from `deploy-staging.yml` (build → migrate → vertex-smoke → rollout → smoke).
  Production gets its own workflow with the prod environment.
- The Apple Team ID (`NY9MS8GSBK`) exists, and the iOS app is registered in `algominutes-staging`. Still
  to do per environment: the App Store Connect record, and the Apple sign-in provider and APNs key in
  Firebase (runbook `resume-staging-and-deploy.md` §3).
