# ===========================================================================
# AlgoMinutes — per-environment infrastructure (BUILD-PLAN A4 / §4.3)
# Region: australia-southeast1 (Sydney) for EVERYTHING.
#
# This module provisions the shared, stateful platform for one environment:
# APIs, networking, Cloud SQL, buckets, Cloud Tasks, Firestore, Artifact
# Registry, per-service runtime service accounts + IAM, and the DB-password
# secret. It deliberately does NOT create the Cloud Run services themselves —
# those images are built and deployed per-service in BUILD-PLAN A11. This
# module only stands up their service accounts, the connector, and the repo.
# ===========================================================================

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = "~> 6.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

# ---------------------------------------------------------------------------
# 1. APIs
# disable_on_destroy = false so a `terraform destroy` never yanks an API out
# from under resources that other tooling (Firebase console, CI) also relies
# on. Enabling is idempotent.
# ---------------------------------------------------------------------------
locals {
  apis = [
    "run.googleapis.com",                  # Cloud Run
    "sqladmin.googleapis.com",             # Cloud SQL Admin
    "storage.googleapis.com",              # Cloud Storage
    "cloudtasks.googleapis.com",           # Cloud Tasks
    "secretmanager.googleapis.com",        # Secret Manager
    "aiplatform.googleapis.com",           # Vertex AI (Gemini)
    "speech.googleapis.com",               # Speech-to-Text v2
    "firestore.googleapis.com",            # Firestore
    "firebase.googleapis.com",             # Firebase management
    "identitytoolkit.googleapis.com",      # Firebase Auth
    "fcm.googleapis.com",                  # Firebase Cloud Messaging (push)
    "artifactregistry.googleapis.com",     # Artifact Registry (service images)
    "cloudbuild.googleapis.com",           # Cloud Build (A11 image builds)
    "iam.googleapis.com",                  # IAM
    "iamcredentials.googleapis.com",       # IAM credentials / workload identity
    "serviceusage.googleapis.com",         # Service Usage
    "servicenetworking.googleapis.com",    # Private Services Access (Cloud SQL private IP)
    "vpcaccess.googleapis.com",            # Serverless VPC Access connector
    "compute.googleapis.com",              # VPC / networking
    "cloudscheduler.googleapis.com",       # Scheduled jobs (cost breaker, cron)
    "logging.googleapis.com",              # Cloud Logging
    "monitoring.googleapis.com",           # Cloud Monitoring
    "cloudresourcemanager.googleapis.com", # Resource Manager (IAM bindings)
  ]
}

resource "google_project_service" "apis" {
  for_each = toset(local.apis)

  project            = var.project_id
  service            = each.value
  disable_on_destroy = false
}

# ---------------------------------------------------------------------------
# 2. Networking
# Invariant (CLAUDE.md): Vertex AI is reachable ONLY from the VPC connector +
# private IP; note the source repo's lesson that generativelanguage.* does not
# work from the connector — Cloud Run must use Vertex (aiplatform) egressing
# through this connector. Cloud SQL is private-IP only (no public IP), reached
# over Private Services Access peering.
# ---------------------------------------------------------------------------

resource "google_compute_network" "vpc" {
  project                 = var.project_id
  name                    = "algominutes-${var.env}-vpc"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

resource "google_compute_subnetwork" "subnet" {
  project                  = var.project_id
  name                     = "algominutes-${var.env}-subnet"
  region                   = var.region
  network                  = google_compute_network.vpc.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true
}

# Reserved range for Private Services Access — Cloud SQL's private IP is
# allocated from here via the servicenetworking peering below.
resource "google_compute_global_address" "psa_range" {
  project       = var.project_id
  name          = "algominutes-${var.env}-psa"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  prefix_length = 16
  network       = google_compute_network.vpc.id
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.vpc.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa_range.name]
  depends_on              = [google_project_service.apis]
}

# Serverless VPC Access connector — Cloud Run egress for private-IP Cloud SQL
# and VPC-only Vertex access. Uses a dedicated /28 that must not overlap the
# primary subnet.
resource "google_vpc_access_connector" "connector" {
  project       = var.project_id
  name          = "algominutes-${var.env}-vpc" # connector name max length is 25 chars
  region        = var.region
  network       = google_compute_network.vpc.name
  ip_cidr_range = var.connector_cidr
  machine_type  = var.vpc_connector_machine_type
  min_instances = var.vpc_connector_min_instances
  max_instances = var.vpc_connector_max_instances
  depends_on    = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# 3. Cloud SQL — Postgres 16, private IP only, ZONAL.
# pgvector is enabled by the application's migration 000 via
# `CREATE EXTENSION vector` — there is NO instance flag to set here.
# ---------------------------------------------------------------------------

resource "google_sql_database_instance" "pg" {
  project             = var.project_id
  name                = "algominutes-${var.env}-pg"
  region              = var.region
  database_version    = "POSTGRES_16"
  deletion_protection = var.deletion_protection # terraform-level guard

  depends_on = [
    google_service_networking_connection.psa,
    google_project_service.apis,
  ]

  settings {
    tier = var.db_tier
    # Google now defaults new Postgres instances to ENTERPRISE_PLUS, which
    # rejects shared-core tiers (db-f1-micro / db-g1-small). Pin the edition
    # explicitly so the chosen tier is valid. See docs/DECISIONS.md (A4).
    edition                     = var.db_edition
    availability_type           = "ZONAL"
    disk_type                   = "PD_SSD"
    disk_size                   = var.db_disk_size_gb
    disk_autoresize             = true
    deletion_protection_enabled = var.deletion_protection # API-level guard

    ip_configuration {
      ipv4_enabled    = false # NO public IP
      private_network = google_compute_network.vpc.id
    }

    backup_configuration {
      enabled                        = true
      point_in_time_recovery_enabled = var.db_point_in_time_recovery
      start_time                     = "16:00" # 02:00–03:00 Sydney, off-peak
      transaction_log_retention_days = var.db_point_in_time_recovery ? 7 : null
    }
  }
}

resource "google_sql_database" "app" {
  project  = var.project_id
  name     = "algominutes"
  instance = google_sql_database_instance.pg.name
}

# App DB password — generated here, never written to any file in the repo.
# Special chars restricted to URL-safe punctuation so the value can be dropped
# straight into a postgres:// connection string without escaping.
resource "random_password" "db" {
  length           = 32
  special          = true
  override_special = "-_.~"
  min_special      = 2
  min_upper        = 2
  min_lower        = 2
  min_numeric      = 2
}

resource "google_sql_user" "app" {
  project  = var.project_id
  name     = "algominutes_app"
  instance = google_sql_database_instance.pg.name
  password = random_password.db.result
}

# Store the password in Secret Manager, pinned to the Sydney region for data
# residency (user-managed replication, not automatic/global).
resource "google_secret_manager_secret" "db_password" {
  project   = var.project_id
  secret_id = "algominutes-${var.env}-db-password"

  replication {
    user_managed {
      replicas {
        location = var.region
      }
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "db_password" {
  secret      = google_secret_manager_secret.db_password.id
  secret_data = random_password.db.result
}

# ---------------------------------------------------------------------------
# 4. Cloud Storage buckets
# recordings / imports / scans — uniform access, versioned, public access
# prevented, regional. Recordings gets a lifecycle deletion rule when
# recordings_lifecycle_days > 0 (staging = 7, prod = 0/off).
# ---------------------------------------------------------------------------
locals {
  bucket_suffixes = ["recordings", "imports", "scans"]
}

resource "google_storage_bucket" "buckets" {
  for_each = toset(local.bucket_suffixes)

  project                     = var.project_id
  name                        = "algominutes-${var.env}-${each.value}"
  location                    = var.region
  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"
  force_destroy               = var.bucket_force_destroy

  versioning {
    enabled = true
  }

  # Lifecycle deletion only on the recordings bucket, only when a positive
  # retention window is configured.
  dynamic "lifecycle_rule" {
    for_each = (each.value == "recordings" && var.recordings_lifecycle_days > 0) ? [1] : []
    content {
      condition {
        age = var.recordings_lifecycle_days
      }
      action {
        type = "Delete"
      }
    }
  }

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# 5. Cloud Tasks queues — one per async pipeline stage.
# Retry config is sane-default; tune per queue later if a stage needs it.
# ---------------------------------------------------------------------------
locals {
  queues = ["transcode", "summarize", "embed", "extract", "notify"]
}

resource "google_cloud_tasks_queue" "queues" {
  for_each = toset(local.queues)

  project  = var.project_id
  name     = each.value
  location = var.region

  rate_limits {
    max_dispatches_per_second = 100
    max_concurrent_dispatches = 50
  }

  retry_config {
    max_attempts       = 10
    min_backoff        = "5s"
    max_backoff        = "300s"
    max_doublings      = 4
    max_retry_duration = "0s" # 0 = retry up to max_attempts with no time cap
  }

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# 6. Firestore — native mode, regional.
# NOTE: location_id is PERMANENT. It cannot be changed after creation; a move
# means deleting and recreating the database. Keep it australia-southeast1.
# ---------------------------------------------------------------------------
resource "google_firestore_database" "db" {
  project         = var.project_id
  name            = "(default)"
  location_id     = var.region
  type            = "FIRESTORE_NATIVE"
  deletion_policy = var.firestore_deletion_policy

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# 7. Artifact Registry — Docker repo where A11 pushes service images.
# ---------------------------------------------------------------------------
resource "google_artifact_registry_repository" "docker" {
  project       = var.project_id
  location      = var.region
  repository_id = "algominutes"
  format        = "DOCKER"
  description   = "AlgoMinutes service container images (${var.env})."

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# 8. Per-service runtime service accounts + least-privilege IAM.
# account_id must be <= 30 chars — all "run-<service>" ids satisfy this.
# ---------------------------------------------------------------------------
locals {
  service_accounts = {
    "run-api"        = "AlgoMinutes API (Cloud Run runtime SA)"
    "run-transcoder" = "AlgoMinutes Transcoder (Cloud Run runtime SA)"
    "run-summarizer" = "AlgoMinutes Summarizer (Cloud Run runtime SA)"
    "run-embedder"   = "AlgoMinutes Embedder (Cloud Run runtime SA)"
    "run-extractor"  = "AlgoMinutes Extractor (Cloud Run runtime SA)"
    "run-billing"    = "AlgoMinutes Billing (Cloud Run runtime SA)"
    "run-notifier"   = "AlgoMinutes Notifier (Cloud Run runtime SA)"
  }

  # Roles common to every service.
  common_roles = [
    "roles/logging.logWriter",
    "roles/cloudtrace.agent",
  ]

  # Project-level role grants per service.
  #
  # These are project-scoped for simplicity. Where a tighter, resource-level
  # binding is possible it is noted:
  #  - secretmanager.secretAccessor could be bound on the specific secret
  #    (algominutes-<env>-db-password) rather than project-wide.
  #  - cloudsql.client is inherently project/instance-scoped at connect time.
  #  - storage.objectAdmin is ALREADY tightened to the three buckets below
  #    (resource-level), not granted here at project scope.
  sa_project_roles = {
    "run-api" = concat(local.common_roles, [
      "roles/cloudsql.client",
      "roles/secretmanager.secretAccessor",
      "roles/cloudtasks.enqueuer",
      "roles/datastore.user",
    ])
    "run-transcoder" = concat(local.common_roles, [
      "roles/cloudsql.client",
      "roles/secretmanager.secretAccessor",
      "roles/cloudtasks.enqueuer",
      "roles/datastore.user",
      "roles/aiplatform.user", # Vertex
      "roles/speech.client",   # Speech-to-Text v2 (speech.googleapis.com)
    ])
    "run-summarizer" = concat(local.common_roles, [
      "roles/cloudsql.client",
      "roles/secretmanager.secretAccessor",
      "roles/cloudtasks.enqueuer",
      "roles/datastore.user",
      "roles/aiplatform.user",
    ])
    "run-embedder" = concat(local.common_roles, [
      "roles/cloudsql.client",
      "roles/secretmanager.secretAccessor",
      "roles/cloudtasks.enqueuer",
      "roles/datastore.user",
      "roles/aiplatform.user",
    ])
    "run-extractor" = concat(local.common_roles, [
      "roles/cloudsql.client",
      "roles/secretmanager.secretAccessor",
      "roles/cloudtasks.enqueuer",
      "roles/datastore.user",
      "roles/aiplatform.user",
    ])
    "run-billing" = concat(local.common_roles, [
      "roles/cloudsql.client",
      "roles/secretmanager.secretAccessor",
      "roles/datastore.user",
    ])
    "run-notifier" = concat(local.common_roles, [
      "roles/datastore.user",
      "roles/secretmanager.secretAccessor",
      # FCM send. firebase.sdkAdminServiceAgent lets the Admin SDK send push
      # via the FCM v1 API. Alternative narrower role: roles/firebasenotifications
      # is console-only; sdkAdminServiceAgent is the correct programmatic grant.
      "roles/firebase.sdkAdminServiceAgent",
    ])
  }

  # Services that read/write objects — get storage.objectAdmin on the buckets
  # (resource-level, tighter than a project grant). billing + notifier do not
  # touch object storage.
  storage_sas = ["run-api", "run-transcoder", "run-summarizer", "run-embedder", "run-extractor"]

  # Flatten { sa => [roles] } into { "sa|role" => {sa, role} } for for_each.
  sa_role_pairs = merge([
    for sa, roles in local.sa_project_roles : {
      for role in roles : "${sa}|${role}" => { sa = sa, role = role }
    }
  ]...)

  # Cartesian product of storage SAs x buckets -> objectAdmin bindings.
  storage_bucket_pairs = merge([
    for sa in local.storage_sas : {
      for b in local.bucket_suffixes : "${sa}|${b}" => { sa = sa, bucket = b }
    }
  ]...)
}

resource "google_service_account" "runtime" {
  for_each = local.service_accounts

  project      = var.project_id
  account_id   = each.key
  display_name = each.value
}

resource "google_project_iam_member" "runtime" {
  for_each = local.sa_role_pairs

  project = var.project_id
  role    = each.value.role
  member  = "serviceAccount:${google_service_account.runtime[each.value.sa].email}"
}

resource "google_storage_bucket_iam_member" "object_admin" {
  for_each = local.storage_bucket_pairs

  bucket = google_storage_bucket.buckets[each.value.bucket].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.runtime[each.value.sa].email}"
}
