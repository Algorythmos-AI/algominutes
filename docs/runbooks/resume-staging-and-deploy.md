# Runbook — resume staging and stand up Cloud Run

> Prereq: you act as **`algorythmos.france@gmail.com`**, the primary working account
> (Owner on the project, Billing Account Administrator). Terraform authenticates with a
> short-lived token from that account, so your default gcloud account and ADC stay untouched.

This runbook un-pauses `algominutes-staging` (paused 2026-08-27, see
`docs/DECISIONS.md`) and brings the backend up for the first time, using the
Terraform added in PR-06. The billing account is a **full (paid) account**. The
A$431 credit is spent first (it expires 2026-11-14), then pay-as-you-go.

## 0. Authenticate as the primary account

```bash
gcloud auth login algorythmos.france@gmail.com --no-activate   # once per machine
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token --account=algorythmos.france@gmail.com)
```

The token lasts about an hour; re-export it if a session runs longer. Every
`gcloud` command below takes `--account=algorythmos.france@gmail.com`.

## 1. Terraform apply (resumes staging + creates Cloud Run)

`activation_policy` is now managed by Terraform (default `ALWAYS`), and the VPC
connector is a declared resource, so a single apply un-pauses the DB **and**
recreates the connector — no out-of-band `gcloud` patch. It also creates the 7
Cloud Run services + the `db-job` Cloud Run Job (with a placeholder image; the
deploy pipeline replaces it), the WIF pool + deployer SA, and the per-stage
queues with `max_attempts = 5`.

**Plan** (read-only; anyone with the primary account can run it):

```bash
cd infra/terraform/envs/staging
# The billing account ID is required (for the budget) but never committed:
export TF_VAR_billing_account=$(gcloud billing projects describe algominutes-staging \
  --account=algorythmos.france@gmail.com --format='value(billingAccountName)' | sed 's#billingAccounts/##')
# Who the alerts email (alerting.tf); also never committed. Empty = console only.
export TF_VAR_alert_emails='["you@example.com"]'
terraform init                                  # real GCS backend
SHA=$(git rev-parse --short HEAD)
terraform plan -lock=false -var-file=terraform.tfvars -out "reviewed-$SHA.tfplan"   # RECORD this output
# The plan check: every service and job gets the env its env-spec.cjs requires,
# api/billing skip the invoker check, and nothing binds allUsers. Must say OK.
terraform show -json "reviewed-$SHA.tfplan" > /tmp/plan.json
node ../../../../scripts/check-tfplan-env.mjs /tmp/plan.json
```

A plan is named after the commit it was made from (`reviewed-<sha>.tfplan`,
git-ignored). A saved plan is self-contained: applying it applies *that* commit's
config, whatever is checked out. So delete a plan once a newer one replaces it, and
keep only one in the folder.

A plan stays current while nothing Terraform reads has changed since its commit: everything
under `infra/terraform` except its READMEs, and `firebase/firestore.rules`.
Merges of app code or docs don't touch it, so `integration` moving on is fine.

**Apply** (the owner), in the same sitting as the first deploy (§3):

```bash
git fetch origin && git switch --detach origin/integration
ls reviewed-*.tfplan                         # one plan; its name carries its commit
# Must print "plan is current". If it prints nothing, Terraform changed since: re-plan.
git -C ../../../.. diff --quiet <sha> HEAD -- infra/terraform ':!infra/terraform/*.md' \
  firebase/firestore.rules && echo "plan is current"
terraform apply reviewed-<sha>.tfplan
```

A saved plan fixes its variables: exporting `TF_VAR_alert_emails` only at apply time
does nothing. If the plan was made without it, re-plan with it set, then apply that plan.

**The organization's policies** (checked 2026-09-26 on `algominutes-staging`):

- `iam.allowedPolicyMemberDomains` is enforced, allowing only the org's own members. Terraform
  therefore never grants `run.invoker` to `allUsers`. The public services (api, billing) set
  `invoker_iam_disabled`, Google's documented way to serve publicly under that policy, and
  `check-tfplan-env.mjs` fails on any `allUsers` member.
- The managed constraint `run.managed.requireInvokerIam` refuses `invoker_iam_disabled` if the org
  enforces it. It can't be read from the project (the Org Policy v2 API is off there). Before the
  first apply, check it at the organization with the admin account; if it's enforced, add a
  project-level exception for `algominutes-staging` and record it in `docs/DECISIONS.md`.

Creating the budget needs `billing.budgets.create` on the billing account
(Billing Account Administrator or Costs Manager); the account owner has it.

Expected in the plan: `google_vpc_access_connector` **created** (deleted at
pause); `google_sql_database_instance … activation_policy = "ALWAYS"`; the
`google_cloud_run_v2_service` ×7, `google_cloud_run_v2_job.db_job`, the WIF
pool/provider, the `gha-deployer` SA, and `google_billing_budget.env` all **created**.
The plan of 2026-09-26 is **93 to add, 9 to change, 0 to destroy**.
The 9 changes are the five queues, the database's `activation_policy`, and three buckets'
retention rules.

**The sweeper starts paused.** The `db-sweep` Scheduler job is created paused: until the first
deploy, its job runs the placeholder image, which would burn its 900 s timeout every 15 minutes.
The deploy workflow resumes it after its smoke passes ("Resume the sweeper"). To keep it paused
during an incident, set the repository variable `SWEEPER_HOLD=true`.

> Note the `*_URL` envs use Cloud Run's deterministic hostname
> `https://SERVICE-PROJECTNUMBER.REGION.run.app`. After apply, confirm the real
> URLs match: `terraform output cloud_run_service_urls`. If the project is on
> legacy per-revision URLs, override the `*_URL` envs in the deploy step.

## 2. Migrations (automatic: the deploy runs them)

The DB is empty (0 tables) after a pause. Nothing to do by hand: every deploy
(step 3) builds the `db-job` image at the deploying commit, runs
`JOB_NAME=migrate` inside the VPC, and only then rolls out services. The first
deploy applies every numbered migration up to the head (the job reads it from
disk; `021_usage_events_created_at.sql` as of 2026-09-26). The job:

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

(The staging root exports `wif_provider_name` and `deployer_service_account_email`
since the infra-staging-outputs PR; with an older checkout, `terraform output` fails.)

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

And one **secret**, the key the authenticated smoke signs up its test user with: the staging iOS
app's Firebase API key, from the git-ignored `GoogleService-Info.plist` (run from the repo root).
Firebase API keys identify the project rather than grant access, but a secret keeps it out of logs:

```bash
/usr/libexec/PlistBuddy -c 'Print :API_KEY' apps/ios/AlgoMinutes/Resources/GoogleService-Info.plist \
  | gh secret set STAGING_FIREBASE_API_KEY
```

The deploy jobs run in the `staging` GitHub Environment, and the WIF provider
rejects tokens from any other ref or environment. Apply the repo settings once,
so the environment's branch policy exists before the first deploy
(`bash scripts/github-settings.sh` shows exactly what will change):

```bash
bash scripts/github-settings.sh --apply
```

Anonymous sign-in must be on before this (below; it is on for staging since 2026-09-26): the
deploy's authenticated smoke signs up an anonymous test user. Then run the first full deploy by
hand (every service still has the placeholder image). It runs build → migrate → rollout → smoke:

```bash
gh workflow run deploy-staging.yml -f services=all
gh run watch
```

Then enable the sign-in providers the app uses, in the Firebase console for
`algominutes-staging` (Authentication → Sign-in method):

- **Anonymous.** The app signs every new user in as a guest at launch; without it the app
  falls back to the login screen.
- **Apple**, with the Services ID, Key ID and `.p8`. Account deletion revokes the Apple tokens
  through it (App Review 5.1.1(v)); without it the revocation fails and is logged.
- **Google** is already on. It also puts `REVERSED_CLIENT_ID` in the iOS
  `GoogleService-Info.plist`, which the iOS build needs.

For push, upload an APNs auth key (`.p8`) under Project settings → Cloud Messaging → Apple app
configuration.

The workflow's `smoke` job runs `scripts/smoke-staging.sh`. It must pass. It
checks that every `*_URL` env is a URL the target service really serves, that
`api` (`/v1/health`) and `billing` (`/health`) answer 200 without auth, that
their readiness probes (`/v1/health/ready`, `/health/ready`) reach Postgres, and
that every worker answers 403 without auth.

Then `scripts/smoke-auth.mjs` uses the services as a real user would, and must pass too. It signs up
an anonymous test user (Anonymous sign-in must be on), reads `/v1/config` and `/v1/entitlement`,
uploads 257 KiB in two chunks through a live GCS resumable session (checking the api's status probe
between them, and that an early `/complete` is refused), searches (Vertex, as `run-api`), then deletes
the account and checks the user is gone. It prints the test user's uid and the log query for it.
The sweeper is resumed only after both smokes pass.

After that, each merge to `integration` (the staging branch) that touches a service redeploys only
the services it affects.

> **TLS ordering.** The instance is `ssl_mode = ENCRYPTED_ONLY` and services get
> `PGSSLMODE=require`. Only images built from `integration` at or after the
> "one Postgres connection config" change can connect under that. An older image's
> repo-layer pool is plaintext and would be rejected. Never roll back a service
> to an image older than that change; roll forward instead.

> Health paths: Cloud Run's front end reserves request paths ending in `z`, so
> an external `GET /healthz` returns a Google 404 before reaching the container.
> Probe `/health` from outside.

## 4. Give internal testers minutes

A TestFlight build has no DeviceCheck trial and the free floor is 0 minutes, so a
tester's first recording answers 402 until they have a grant (migration 019). The
tester opens the app once (so their user row exists) and sends you the User ID shown in
Settings. (Builds before that row exists: have the tester sign in with Apple or Google and use
`GRANT_EMAIL` instead.) Then:

```bash
gcloud run jobs execute db-job --region australia-southeast1 --project algominutes-staging \
  --account=algorythmos.france@gmail.com --wait \
  --update-env-vars JOB_NAME=grant-tester,GRANT_UID=<the tester's User ID>
```

That grants Pro (1,500 minutes a month) for 90 days. `GRANT_EMAIL` works instead of
the uid for a tester signed in with Apple or Google (a guest has no email); `GRANT_DAYS=0` never expires;
`GRANT_MINUTES=3000` raises the allowance; `MODE=revoke` removes it. The log line
carries the uid, never the email, and the email never goes into git.

Prefer `GRANT_UID` when you have it: the email match trusts the sign-in token's
email claim, and the job execution (and its audit log) records the env vars you
pass. Check that the uid in the `entitlement_granted` log line is your tester's.

## 5. After your first sign-in: the admin view

The dead-letter view (`/v1/admin/dead-letters`) answers 403 to everyone until the api has
`ADMIN_UIDS`. Once you have signed in to a staging build, re-plan with your uid (never
committed) and apply that plan:

```bash
export TF_VAR_admin_uids='["<your uid>"]'
terraform plan -lock=false -var-file=terraform.tfvars -out "reviewed-$(git rev-parse --short HEAD).tfplan"
```

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

**Trial end: decided.** The billing account was upgraded to a full (paid) account
(2026-09-25). Remaining credit is spent first until 2026-11-14, then usage is
billed pay-as-you-go. Nothing stops on 14 Nov. The budget alerts above are
what watch the spend. To stop spend, pause (below).

## Pausing again (cost control)

To re-pause without deleting data, set in `envs/staging/terraform.tfvars`:

```hcl
db_activation_policy = "NEVER"
```

and `terraform apply`. (The connector still bills at its 2-instance floor; to
reach zero, also `terraform destroy -target=module.environment.google_vpc_access_connector.connector`,
which the next apply recreates.)
