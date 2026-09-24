# ===========================================================================
# AlgoMinutes — Cloud Run services + job, task-invocation IAM, and the keyless
# CI deploy identity (Workload Identity Federation). BUILD-PLAN A11.
#
# The service images are built and pushed by the deploy workflow (PR-07); this
# module creates each service with a PLACEHOLDER image and ignores image changes
# thereafter, so `terraform apply` can stand the services up before any image
# exists and the deploy pipeline owns the image tag from then on.
#
# Downstream service URLs use Cloud Run's deterministic hostname
# (https://SERVICE-PROJECTNUMBER.REGION.run.app), which lets one service's env
# reference another without a resource cycle. If a project is still on legacy
# per-revision URLs, override the *_URL envs in the deploy step.
# ===========================================================================

locals {
  # Public "hello" image used only until the deploy pipeline pushes the real one.
  placeholder_image = "us-docker.pkg.dev/cloudrun/container/hello"

  region_bucket = { for s in local.bucket_suffixes : s => "algominutes-${var.env}-${s}" }

  # Deterministic Cloud Run URLs (see header).
  service_names = ["api", "transcoder", "summarizer", "embedder", "extractor", "billing", "notifier"]
  service_url   = { for s in local.service_names : s => "https://${s}-${var.project_number}.${var.region}.run.app" }

  # Per-service runtime sizing. Long-audio transcode gets the most head-room and
  # concurrency 1 (one CPU-bound chunk job per instance); the rest are modest.
  service_config = {
    api        = { cpu = "1", memory = "512Mi", timeout = 60, concurrency = 80, sa = "run-api" }
    transcoder = { cpu = "2", memory = "2Gi", timeout = 3600, concurrency = 1, sa = "run-transcoder" }
    summarizer = { cpu = "1", memory = "1Gi", timeout = 900, concurrency = 4, sa = "run-summarizer" }
    embedder   = { cpu = "1", memory = "512Mi", timeout = 600, concurrency = 4, sa = "run-embedder" }
    extractor  = { cpu = "1", memory = "1Gi", timeout = 900, concurrency = 4, sa = "run-extractor" }
    billing    = { cpu = "1", memory = "512Mi", timeout = 60, concurrency = 80, sa = "run-billing" }
    notifier   = { cpu = "1", memory = "256Mi", timeout = 60, concurrency = 20, sa = "run-notifier" }
  }

  # Env every service shares.
  common_env = {
    NODE_ENV                       = "production"
    GOOGLE_CLOUD_PROJECT           = var.project_id
    GCLOUD_PROJECT                 = var.project_id
    TASKS_PROJECT                  = var.project_id
    TASKS_LOCATION                 = var.region
    AIPLATFORM_LOCATION            = var.region
    JOBS_SA_EMAIL                  = google_service_account.runtime["run-jobs"].email
    MAX_TASK_ATTEMPTS              = tostring(var.task_max_attempts)
    TASK_DISPATCH_DEADLINE_SECONDS = "1800"
    TRANSCODE_QUEUE                = "transcode"
    SUMMARIZE_QUEUE                = "summarize"
    EMBED_QUEUE                    = "embed"
    EXTRACT_QUEUE                  = "extract"
    NOTIFY_QUEUE                   = "notify"
    TRANSCODER_URL                 = local.service_url["transcoder"]
    SUMMARIZER_URL                 = local.service_url["summarizer"]
    EMBEDDER_URL                   = local.service_url["embedder"]
    EXTRACTOR_URL                  = local.service_url["extractor"]
    NOTIFIER_URL                   = local.service_url["notifier"]
  }

  # Postgres connection env for the DB-touching services (password comes from a
  # Secret Manager ref, not a plain value — see the dynamic env below).
  db_env = {
    # Postgres is the source of truth (CLAUDE.md §1). Every @algominutes/db repo
    # function and the api's pg-query reads are no-ops unless this is 'true' —
    # a leftover migration toggle from the Firestore-only era. Unset, staging
    # would silently drop note writes and dead-letter rows.
    WRITE_POSTGRES = "true"
    # Every pool encrypts (pg-config.cjs); the instance is ENCRYPTED_ONLY.
    PGSSLMODE  = "require"
    PGHOST     = google_sql_database_instance.pg.private_ip_address
    PGPORT     = "5432"
    PGDATABASE = google_sql_database.app.name
    PGUSER     = google_sql_user.app.name
  }

  # Per-service extra plain env, merged over common_env.
  service_env = {
    api        = merge(local.db_env, { STORAGE_BUCKET = local.region_bucket["recordings"], ALLOWED_ORIGINS = var.allowed_origins })
    transcoder = merge(local.db_env, { GCS_BUCKET = local.region_bucket["recordings"], LANGUAGE_CODES = "en-US,en-GB,en-AU", STT_PROVIDER = "google" })
    summarizer = local.db_env
    embedder   = local.db_env
    extractor  = { GCS_BUCKET = local.region_bucket["imports"], TESSERACT_CACHE_PATH = "/tmp/tesseract" }
    billing    = local.db_env
    notifier   = local.db_env
  }

  # Which services connect to Postgres (get the db-password secret). Every
  # service that imports @algominutes/db belongs here — api (repo layer),
  # billing (subscriptions repo), notifier (push-tokens repo) included.
  db_services = ["api", "billing", "notifier", "transcoder", "summarizer", "embedder"]

  # Services end users / third parties call directly. They authenticate at the
  # application layer (api: Firebase ID token; billing: store/Stripe webhook
  # signatures), so Cloud Run IAM must admit unauthenticated requests. Every
  # other service stays private (only run-jobs may invoke).
  public_services = ["api", "billing"]
}

resource "google_cloud_run_v2_service" "services" {
  for_each = local.service_config

  project  = var.project_id
  name     = each.key
  location = var.region
  # Network ingress is open; *who* may invoke is IAM (see jobs_invoker and
  # public_invoker below): workers are private, api/billing are public.
  ingress = "INGRESS_TRAFFIC_ALL"

  deletion_protection = false

  template {
    service_account                  = google_service_account.runtime[each.value.sa].email
    timeout                          = "${each.value.timeout}s"
    max_instance_request_concurrency = each.value.concurrency

    scaling {
      min_instance_count = 0
      max_instance_count = var.cloud_run_max_instances
    }

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }

    containers {
      image = local.placeholder_image

      resources {
        limits = {
          cpu    = each.value.cpu
          memory = each.value.memory
        }
        cpu_idle          = each.value.concurrency > 1
        startup_cpu_boost = true
      }

      ports {
        container_port = 8080
      }

      # Plain env: common + per-service overrides.
      dynamic "env" {
        for_each = merge(local.common_env, local.service_env[each.key])
        content {
          name  = env.key
          value = env.value
        }
      }

      # DB password from Secret Manager for the Postgres services.
      dynamic "env" {
        for_each = contains(local.db_services, each.key) ? [1] : []
        content {
          name = "PGPASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.db_password.secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  # The deploy pipeline owns the image tag; Terraform owns everything else.
  lifecycle {
    ignore_changes = [
      template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [
    google_project_service.apis,
    google_project_iam_member.runtime,
    google_secret_manager_secret_version.db_password,
  ]
}

# db-job runs as a Cloud Run JOB (one-shot, JOB_NAME-driven), not a service.
resource "google_cloud_run_v2_job" "db_job" {
  project  = var.project_id
  name     = "db-job"
  location = var.region

  deletion_protection = false

  template {
    template {
      service_account = google_service_account.runtime["run-db-job"].email
      max_retries     = 1
      timeout         = "3600s"

      vpc_access {
        connector = google_vpc_access_connector.connector.id
        egress    = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image = local.placeholder_image
        resources {
          limits = { cpu = "1", memory = "1Gi" }
        }
        dynamic "env" {
          # STORAGE_BUCKET: the sweep's purges (JOB_NAME=sweep, scheduler.tf).
          for_each = merge(local.common_env, local.db_env, { STORAGE_BUCKET = local.region_bucket["recordings"] })
          content {
            name  = env.key
            value = env.value
          }
        }
        env {
          name = "PGPASSWORD"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.db_password.secret_id
              version = "latest"
            }
          }
        }
      }
    }
  }

  lifecycle {
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [google_project_service.apis, google_project_iam_member.runtime]
}

# ---------------------------------------------------------------------------
# Task-invocation IAM
# run-jobs is the OIDC identity Cloud Tasks carries; it needs run.invoker on
# each service. The enqueuing services (api, transcoder, summarizer) must be
# able to mint a token AS run-jobs -> actAs (serviceAccountUser) on it.
# ---------------------------------------------------------------------------
resource "google_cloud_run_v2_service_iam_member" "jobs_invoker" {
  for_each = google_cloud_run_v2_service.services

  project  = var.project_id
  location = var.region
  name     = each.value.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.runtime["run-jobs"].email}"
}

# api + billing are called by the app / store webhooks without a Google identity.
resource "google_cloud_run_v2_service_iam_member" "public_invoker" {
  for_each = toset(local.public_services)

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_service.services[each.value].name
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_service_account_iam_member" "act_as_jobs" {
  for_each = toset(["run-api", "run-transcoder", "run-summarizer"])

  service_account_id = google_service_account.runtime["run-jobs"].name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.runtime[each.value].email}"
}

# ---------------------------------------------------------------------------
# Keyless CI deploy identity — Workload Identity Federation for GitHub Actions.
# Only var.github_repo's workflows can impersonate the deployer SA; no JSON key
# is ever created or stored.
# ---------------------------------------------------------------------------
resource "google_service_account" "deployer" {
  project      = var.project_id
  account_id   = "gha-deployer"
  display_name = "GitHub Actions deployer (${var.env})"
}

resource "google_project_iam_member" "deployer_roles" {
  for_each = toset([
    "roles/run.admin",
    "roles/cloudbuild.builds.editor",
    "roles/artifactregistry.writer",
    "roles/iam.serviceAccountUser", # deploy a service running AS a runtime SA
    "roles/cloudscheduler.admin",
    "roles/serviceusage.serviceUsageConsumer",
  ])

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.deployer.email}"
}

resource "google_iam_workload_identity_pool" "github" {
  project                   = var.project_id
  workload_identity_pool_id = "github-${var.env}"
  display_name              = "GitHub Actions (${var.env})"
  depends_on                = [google_project_service.apis]
}

resource "google_iam_workload_identity_pool_provider" "github" {
  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github.workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub OIDC"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.repository" = "assertion.repository"
  }
  # Fail-closed: a token is accepted only from THIS repo, on this environment's
  # branch(es), in a job running in its GitHub Environment (whose protection
  # rules apply). A workflow on any other branch, a PR ref (refs/pull/N/merge),
  # or a job without the environment is rejected: a missing claim cannot
  # satisfy the expression.
  attribute_condition = join(" && ", [
    "assertion.repository == \"${var.github_repo}\"",
    "(${join(" || ", [for r in var.wif_allowed_refs : "assertion.ref == \"${r}\""])})",
    "assertion.environment == \"${var.wif_github_environment}\"",
  ])

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

# Bind the pool (scoped to our repo) to the deployer SA.
resource "google_service_account_iam_member" "deployer_wif" {
  service_account_id = google_service_account.deployer.name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github.name}/attribute.repository/${var.github_repo}"
}

# ---------------------------------------------------------------------------
# Cloud NAT — off until diarisation go-live (PR-28). Cloud Run reaches Google
# APIs (Vertex) via Private Google Access; third-party STT needs a public
# egress path through the connector, which NAT provides.
# ---------------------------------------------------------------------------
resource "google_compute_router" "nat" {
  count = var.enable_nat ? 1 : 0

  project = var.project_id
  name    = "algominutes-${var.env}-nat-router"
  region  = var.region
  network = google_compute_network.vpc.id
}

resource "google_compute_router_nat" "nat" {
  count = var.enable_nat ? 1 : 0

  project                            = var.project_id
  name                               = "algominutes-${var.env}-nat"
  router                             = google_compute_router.nat[0].name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}
