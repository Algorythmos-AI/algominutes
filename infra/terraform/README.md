# AlgoMinutes — Infrastructure as Code (Terraform)

Apply-ready Terraform for BUILD-PLAN **A4 / §4.3**. One reusable
`modules/environment` module provisions a full AlgoMinutes environment; the
`envs/staging` and `envs/prod` root modules are thin callers that only pick
tiers. Everything is region **australia-southeast1** (Sydney).

> Terraform authors the shared platform: APIs, VPC + connector, Cloud SQL,
> buckets, Cloud Tasks, Firestore, Artifact Registry, per-service runtime
> service accounts + IAM, and the DB-password secret. It does **not** deploy
> the Cloud Run services — those images are built and deployed per service in
> **A11**.

## Layout

```
infra/terraform/
├── versions.tf                    # canonical provider/version pins
├── modules/environment/           # the reusable per-env module
│   ├── variables.tf
│   ├── main.tf
│   └── outputs.tf
└── envs/
    ├── staging/                   # db-f1-micro, PITR off, protection off, 7-day recordings
    │   ├── main.tf  backend.tf  terraform.tfvars
    └── prod/                      # db-custom-1-3840, PITR on, protection on
        ├── main.tf  backend.tf  terraform.tfvars
```

## Prerequisites

- Terraform >= 1.9.
- A shell authenticated as **`gcp-admin@algorythmos.com`** with Owner on the
  target project:
  `gcloud auth application-default login`
- Both projects already exist and are billing-linked (see
  `docs/INFRASTRUCTURE.md` §4.3).

## One-time bootstrap — the state bucket (per env)

Terraform cannot create the bucket that stores its own state, so create it once
by hand **before** the first `init`:

```bash
# staging
gcloud storage buckets create gs://algominutes-staging-tfstate \
  --project=algominutes-staging --location=australia-southeast1 \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://algominutes-staging-tfstate --versioning

# prod
gcloud storage buckets create gs://algominutes-prod-tfstate \
  --project=algominutes-prod --location=australia-southeast1 \
  --uniform-bucket-level-access --public-access-prevention
gcloud storage buckets update gs://algominutes-prod-tfstate --versioning
```

> ⚠️ **State contains the DB password in plaintext.** It lives only in these
> GCS buckets, never in git (`.gitignore` enforces this). Keep the buckets
> private + versioned.

## Apply (per environment)

```bash
cd infra/terraform/envs/staging   # or envs/prod
terraform init                    # downloads providers, wires the GCS backend
terraform plan                    # tfvars are auto-loaded
terraform apply
```

Run the two environments independently; there is no shared state and no
cross-env peering.

### Validate without cloud access (author-time)

```bash
terraform init -backend=false
terraform validate
terraform fmt -recursive
```

## Staging vs prod

| Setting                     | staging        | prod              |
|-----------------------------|----------------|-------------------|
| Cloud SQL tier              | `db-f1-micro`  | `db-custom-1-3840`|
| Data disk                   | 10 GB          | 20 GB             |
| Point-in-time recovery      | off            | on                |
| `deletion_protection`       | off            | on                |
| Recordings lifecycle        | delete @ 7 days| kept (no rule)    |
| Bucket `force_destroy`      | true           | false             |
| Firestore deletion policy   | `DELETE`       | `ABANDON`         |

Everything else (region, IAM shape, networking, queues, service accounts) is
identical — staging is the same architecture at the smallest viable tier.

## What this module provisions

1. **APIs** — the full set A4 needs, `disable_on_destroy = false`.
2. **Networking** — VPC, regional subnet, Private Services Access (Cloud SQL
   private IP), and a Serverless VPC Access connector for Cloud Run egress.
3. **Cloud SQL** — Postgres 16, private IP only, ZONAL, PD_SSD autoresize,
   backups on, PITR + deletion protection by var. Database `algominutes`, user
   `algominutes_app` with a `random_password` stored in Secret Manager as
   `algominutes-<env>-db-password`. (pgvector is enabled by app migration 000
   via `CREATE EXTENSION vector` — no instance flag.)
4. **Buckets** — `algominutes-<env>-{recordings,imports,scans}`: uniform
   access, versioned, public access prevented, regional; 7-day lifecycle on the
   staging recordings bucket.
5. **Cloud Tasks** — `transcode`, `summarize`, `embed`, `extract`, `notify`.
6. **Firestore** — native mode, regional (location is PERMANENT).
7. **Artifact Registry** — Docker repo `algominutes`.
8. **Service accounts** — `run-{api,transcoder,summarizer,embedder,extractor,
   billing,notifier}` with least-privilege IAM. Storage `objectAdmin` is bound
   at the bucket level (tighter than project scope).

## Manual steps NOT covered by Terraform

- **State-bucket bootstrap** (above) — once per env.
- **Firebase app registration** — iOS / Android / Web app registration and
  config download (`GoogleService-Info.plist`, `google-services.json`, web
  config). These must be **regenerated per environment, never copied** from the
  source project. Auth providers (Google + Apple sign-in) are enabled in the
  Firebase console.
- **Domain mapping** — mapping `api.algominutes.com` (and the web domain) to
  Cloud Run happens in A11 alongside service deploy.
- **Cloud Run services themselves** — built + deployed per service in A11
  (wire the VPC connector output as the egress connector, mount the DB-password
  secret, attach the matching `run-*` service account).
- **Prod budget re-scope** — `algominutes-prod-budget` still spans the whole
  billing account; re-scope to the prod project (INFRASTRUCTURE.md open item
  #2). Budgets are **not** managed here.
- **Application-level daily spend circuit breaker** (§4.6) — enforced in code,
  not GCP.
