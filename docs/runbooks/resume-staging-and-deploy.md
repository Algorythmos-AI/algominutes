# Runbook — resume staging and stand up Cloud Run

> Prereq: you must be `gcp-admin@algorythmos.com`. The Terraform state bucket
> (`gs://algominutes-staging-tfstate`) denies `skalaliya@gmail.com`, so ADC must
> be the admin account or every `plan`/`apply` fails with a 403.

This runbook un-pauses `algominutes-staging` (paused 2026-08-27, see
`docs/DECISIONS.md`) and brings the backend up for the first time, using the
Terraform added in PR-06. **It resumes billing against the A$431 trial credit
(expires 14 Nov 2026).**

## 0. Authenticate as the admin

```bash
gcloud auth application-default login   # choose gcp-admin@algorythmos.com
gcloud config set account gcp-admin@algorythmos.com
gcloud config set project algominutes-staging
```

## 1. Terraform apply (resumes staging + creates Cloud Run)

`activation_policy` is now managed by Terraform (default `ALWAYS`), and the VPC
connector is a declared resource, so a single apply un-pauses the DB **and**
recreates the connector — no out-of-band `gcloud` patch. It also creates the 7
Cloud Run services + the `db-job` Cloud Run Job (with a placeholder image; the
deploy pipeline replaces it), the WIF pool + deployer SA, and the per-stage
queues with `max_attempts = 5`.

```bash
cd infra/terraform/envs/staging
# The billing account ID is required (for the budget) but never committed:
export TF_VAR_billing_account=$(gcloud billing projects describe algominutes-staging \
  --format='value(billingAccountName)' | sed 's#billingAccounts/##')
terraform init                                  # real GCS backend this time
terraform plan  -var-file=terraform.tfvars -out plan.out   # RECORD this output
terraform apply plan.out
```

Creating the budget needs `billing.budgets.create` on the billing account
(Billing Account Administrator or Costs Manager); the account owner has it.

Expected in the plan: `google_vpc_access_connector` **created** (deleted at
pause); `google_sql_database_instance … activation_policy = "ALWAYS"`; the
`google_cloud_run_v2_service` ×7, `google_cloud_run_v2_job.db_job`, the WIF
pool/provider, the `gha-deployer` SA, and `google_billing_budget.env` all **created**.

> Note the `*_URL` envs use Cloud Run's deterministic hostname
> `https://SERVICE-PROJECTNUMBER.REGION.run.app`. After apply, confirm the real
> URLs match: `terraform output cloud_run_service_urls`. If the project is on
> legacy per-revision URLs, override the `*_URL` envs in the deploy step.

## 2. Migrations (automatic: the deploy runs them)

The DB is empty (0 tables) after a pause. Nothing to do by hand: every deploy
(step 3) builds the `db-job` image at the deploying commit, runs
`JOB_NAME=migrate` inside the VPC, and only then rolls out services. The first
deploy applies `000..012`. The job:

- runs as the Cloud SQL built-in user `algominutes_app` (a `cloudsqlsuperuser`
  member, so `000_extensions.sql` can create `vector`/`pg_trgm`/`uuid-ossp`);
- takes an advisory lock, so overlapping runs serialize;
- caps DDL lock waits at 15s, failing the deploy rather than queueing behind
  live traffic (re-run the deploy to retry);
- refuses a file that changed after it was applied;
- fails unless every file on disk is recorded afterwards.

Independent check, or the manual fallback if the job can't run, over the
Cloud SQL Auth Proxy:

```bash
export DATABASE_URL="postgres://algominutes_app:$(gcloud secrets versions access latest \
  --secret=algominutes-staging-db-password)@127.0.0.1:5432/algominutes"
node scripts/check-migrations-applied.mjs   # PASS = schema at head
npm run migrate                             # fallback only: same runner as the job
```

## 3. Turn on the deploy pipeline (`.github/workflows/deploy-staging.yml`)

The workflow is keyless (WIF) and does nothing until it is enabled. Set four
**repository variables** (not secrets — none of these is sensitive) from the
Terraform outputs:

```bash
cd infra/terraform/envs/staging
gh variable set GCP_PROJECT_ID   --body algominutes-staging
gh variable set GCP_WIF_PROVIDER --body "$(terraform output -raw wif_provider_name)"
gh variable set GCP_DEPLOYER_SA  --body "$(terraform output -raw deployer_service_account_email)"
gh variable set DEPLOY_STAGING   --body true
```

Then run the first full deploy by hand (every service still has the
placeholder image). It runs build → migrate → rollout → smoke:

```bash
gh workflow run deploy-staging.yml -f services=all
gh run watch
```

The workflow's `smoke` job runs `scripts/smoke-staging.sh`. It must pass. It
checks that every `*_URL` env is a URL the target service really serves, that
`api` (`/v1/health`) and `billing` (`/health`) answer 200 without auth, that
their readiness probes (`/v1/health/ready`, `/health/ready`) reach Postgres, and
that every worker answers 403 without auth. After that, each merge to `integration` (the staging branch)
that touches a service redeploys only the services it affects.

> **TLS ordering.** The instance is `ssl_mode = ENCRYPTED_ONLY` and services get
> `PGSSLMODE=require`. Only images built from `integration` at or after the
> "one Postgres connection config" change can connect under that. An older image's
> repo-layer pool is plaintext and would be rejected. Never roll back a service
> to an image older than that change; roll forward instead.

> Health paths: Cloud Run's front end reserves request paths ending in `z`, so
> an external `GET /healthz` returns a Google 404 before reaching the container.
> Probe `/health` from outside.

## Budget alerts and the end of the free trial (14 Nov 2026)

Terraform creates a monthly budget for the project (`budget.tf`): **A$100 of gross
cost, with credits excluded**. It measures what the trial credit is paying for,
which is also what staging will cost once billing is paid. Billing account admins
get an email:

- at 50%, 90% and 100% of actual spend;
- when the month is *forecast* to pass 100%.

On the trial the invoice stays $0, so these emails are the only signal that the
credit is burning.

| Alert | Likely cause | Do |
|---|---|---|
| 50% early in the month | something left running (a Cloud Run min-instance, a load test, NAT turned on) | check Billing → Reports grouped by SKU; fix or pause |
| forecast 100% | steady spend above plan | raise `monthly_budget` deliberately, or cut |
| 100% | over budget | pause (below) unless it's expected |

**Before 14 Nov**, decide one of the following and record it in `docs/DECISIONS.md`:

1. **Upgrade to a paid billing account** and keep staging running. Idle staging is
   Cloud SQL `db-f1-micro` plus the 2-instance VPC connector; the budget reports
   show the real monthly figure.
2. **Pause** (next section) and resume when needed.

Under Google's free-trial terms, resources on a trial that ends without an upgrade
are stopped, and are deleted if you still don't upgrade within the grace period.
Check the current wording on the Billing page. Do not let the date pass
undecided.

## Pausing again (cost control)

To re-pause without deleting data, set in `envs/staging/terraform.tfvars`:

```hcl
db_activation_policy = "NEVER"
```

and `terraform apply`. (The connector still bills at its 2-instance floor; to
reach zero, also `terraform destroy -target=module.environment.google_vpc_access_connector.connector`,
which the next apply recreates.)
