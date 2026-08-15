# Runbook — GCP provisioning (A4, non-Apple)

How to take AlgoMinutes infrastructure **live** per environment. Everything here is authored as
apply-ready Terraform (`infra/terraform/`) plus the manual Firebase steps Terraform can't do. It was
**not run** in the automated session — the session's gcloud identity (`skalaliya@gmail.com`) has no access
to the org projects. Run it from a shell authenticated as the org admin.

> **No secrets in git.** Terraform stores a generated DB password in Secret Manager; the runtime reads it
> via the service account. Never commit `.tfstate` (it contains that password) — the GCS backend keeps it.

## 0. Prerequisites

```bash
gcloud auth login gcp-admin@algorythmos.com      # org admin — owns both projects
gcloud auth application-default login gcp-admin@algorythmos.com   # ADC for Terraform
gcloud config set account gcp-admin@algorythmos.com
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
terraform init                       # uses the gcs backend from step 1
terraform plan -out=tfplan           # REVIEW the plan before applying
terraform apply tfplan               # Cloud SQL creation takes ~10 min
```
Repeat in `infra/terraform/envs/prod`. **Review each plan** — prod has `deletion_protection` on and a
Firestore location that is **permanent** once created.

This provisions (both envs, `australia-southeast1`): APIs, a VPC + serverless connector + private services
access, Cloud SQL Postgres (private IP), the `algominutes` DB + a Secret-Manager-stored password, the
three buckets (staging recordings = 7-day lifecycle), the five Cloud Tasks queues, a Firestore database,
an Artifact Registry repo, and the seven per-service runtime service accounts + IAM. It does **not** deploy
Cloud Run services — images are built and deployed per-service in A11.

## 3. Firestore mode + Firebase Auth (console / CLI — not Terraform)

- Terraform creates the Firestore **database**; enable the sign-in providers in the Firebase console →
  Authentication: **Google** and **Apple** (Apple needs the Team ID — A4-apple).
- Confirm the default Firestore security rules are replaced by the repo's `firestore.rules` /
  `storage.rules` at deploy (A11).

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

## 6. Run migrations against Cloud SQL

From a shell with Cloud SQL access (Auth Proxy or the bastion pattern):
```bash
DATABASE_URL="postgres://…" npm run migrate      # applies packages/db/migrations 000-006
```
Migration `000_extensions.sql` runs `CREATE EXTENSION vector` (pgvector is a supported Cloud SQL extension).

## 7. Post-apply verification (BUILD-PLAN "Verify")

- [ ] `gcloud sql instances describe algominutes-<env>-pg` — RUNNABLE, private IP only.
- [ ] Buckets exist; staging recordings bucket shows the 7-day lifecycle rule.
- [ ] Five Cloud Tasks queues exist per env.
- [ ] **Backup restore test (§4.7):** restore a Cloud SQL backup into a throwaway instance at least once.
- [ ] **Spend circuit breaker (§4.6):** in staging, wire the A9 spend reader to a value ≥ A$20 and confirm
      the transcoder/summarizer ack with `deferred: spend_cap` and do not process. (Until the A9 reader
      exists the breaker is inert — see `packages/ai/src/spend-guard.cjs`.)

## 8. Open items carried from INFRASTRUCTURE.md

- Re-scope `algominutes-prod-budget` from the whole billing account to the prod project only.
- Cloud Run **deploys** (build → Artifact Registry → deploy with SA + VPC connector + env incl.
  `DAILY_SPEND_CAP_AUD`, `STORAGE_BUCKET`, `PG*`) are **A11**, per-service.
- Apple half (Team ID → iOS Firebase app, App Store Connect) is blocked on enrolment — `TODO(A4-apple)`.
