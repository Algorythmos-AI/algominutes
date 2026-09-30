# ---------------------------------------------------------------------------
# The periodic sweeper (plan PR-15): services/db-job/src/handlers/sweep.js.
# It retries storage purges, fails notes stuck in flight, drops expired upload
# sessions, finishes account deletions a client abandoned, and prunes old
# tombstones.
#
# Least privilege, deliberately:
#   * db-sweep is its OWN Cloud Run Job (the db-job image, JOB_NAME=sweep baked
#     in) with its own SA, run-sweep. It can't run migrations or the other
#     db-job handlers, and they don't get the sweep's grants.
#   * Cloud Scheduler starts it as run-scheduler, which holds run.invoker on
#     this one job, so it can run it but can't override its env.
#   * run-sweep can delete Firebase Auth users (a custom role with only
#     firebaseauth.users.delete) and admin objects in the recordings bucket
#     only (all note content lives there, under recordings/, imports/, scans/).
# ---------------------------------------------------------------------------

# Only the permission the account deletion needs: delete the Auth user. Shared
# by the api (POST /v1/account/delete, which had no Auth grant at all) and the
# sweep (finishing an abandoned deletion).
resource "google_project_iam_custom_role" "auth_user_deleter" {
  project     = var.project_id
  role_id     = "algominutesAuthUserDeleter"
  title       = "AlgoMinutes: delete Firebase Auth users"
  description = "Account deletion only: firebaseauth.users.delete."
  permissions = ["firebaseauth.users.delete"]
}

resource "google_project_iam_member" "auth_user_deleter" {
  for_each = toset(["run-api", "run-sweep"])

  project = var.project_id
  role    = google_project_iam_custom_role.auth_user_deleter.id
  member  = "serviceAccount:${google_service_account.runtime[each.value].email}"
}

resource "google_storage_bucket_iam_member" "sweep_recordings" {
  bucket = google_storage_bucket.buckets["recordings"].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.runtime["run-sweep"].email}"
}

resource "google_cloud_run_v2_job" "db_sweep" {
  count = var.enable_sweeper ? 1 : 0

  project  = var.project_id
  name     = "db-sweep"
  location = var.region

  deletion_protection = false

  template {
    template {
      service_account = google_service_account.runtime["run-sweep"].email
      max_retries     = 0 # the next tick is the retry; the sweep is idempotent and locks against overlap
      timeout         = "900s"

      vpc_access {
        connector = google_vpc_access_connector.connector.id
        egress    = "PRIVATE_RANGES_ONLY"
      }

      containers {
        image = local.placeholder_image
        resources {
          limits = { cpu = "1", memory = "512Mi" }
        }
        dynamic "env" {
          for_each = merge(local.common_env, local.db_env, {
            JOB_NAME       = "sweep"
            STORAGE_BUCKET = local.region_bucket["recordings"]
            PG_POOL_MAX    = tostring(var.connection_budget.jobs["db-sweep"].pool_max)
          })
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
    # The deploy points it at each commit's db-job image (deploy-staging.yml).
    ignore_changes = [
      template[0].template[0].containers[0].image,
      client,
      client_version,
    ]
  }

  depends_on = [google_project_service.apis, google_project_iam_member.runtime]
}

resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_sweep" {
  count = var.enable_sweeper ? 1 : 0

  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.db_sweep[0].name
  role     = "roles/run.invoker" # run it; not override it
  member   = "serviceAccount:${google_service_account.runtime["run-scheduler"].email}"
}

resource "google_cloud_scheduler_job" "sweep" {
  count = var.enable_sweeper ? 1 : 0

  project          = var.project_id
  region           = var.region
  name             = "db-sweep"
  description      = "Runs the db-sweep job (storage purges, stuck notes, upload sessions, account deletions, tombstones)."
  schedule         = var.sweep_schedule
  time_zone        = "Etc/UTC"
  attempt_deadline = "60s" # starting the job; the sweep itself runs in the job

  # Created paused: until the first deploy, db-sweep runs the placeholder image,
  # which never exits cleanly, so every tick would burn its 900 s timeout. The
  # deploy workflow resumes it once a real image has rolled out and passed the
  # smoke (deploy-staging.yml, "Resume the sweeper"). Terraform doesn't fight
  # that: it sets `paused` at creation only.
  paused = true

  retry_config {
    retry_count = 0 # the next tick is the retry
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.db_sweep[0].name}:run"

    oauth_token {
      service_account_email = google_service_account.runtime["run-scheduler"].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  lifecycle {
    ignore_changes = [paused]
  }

  depends_on = [google_project_service.apis, google_cloud_run_v2_job_iam_member.scheduler_runs_sweep]
}

# ---------------------------------------------------------------------------
# The notetaker's purge worker (services/meetings/src/tasks/ingest.js
# purge_media): every 30 minutes, asks Recall again to delete its copy of each
# recording not yet confirmed deleted, and logs recall_purge_exhausted for each
# that ran out of attempts (alerting.tf). The purge rows are the queue: ingest,
# a failed bot and (PR 21) a deleted note each add one.
#
# Called as Cloud Tasks call it (lib/task-auth.js): an OIDC token issued to
# run-jobs, for exactly this URL. No retries: the next tick is the retry. With
# nothing pending it reads one table and never calls Recall.
# ---------------------------------------------------------------------------
resource "google_cloud_scheduler_job" "meetings_purge_media" {
  project          = var.project_id
  region           = var.region
  name             = "meetings-purge-media"
  description      = "Retries deleting Recall's copies of notetaker recordings until each is confirmed (meetings /tasks/purge_media)."
  schedule         = "*/30 * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "300s"

  retry_config {
    retry_count = 0 # the next tick is the retry
  }

  http_target {
    http_method = "POST"
    uri         = "${local.service_url["meetings"]}/tasks/purge_media"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode(jsonencode({ kind = "purge_media" }))

    oidc_token {
      service_account_email = google_service_account.runtime["run-jobs"].email
      audience              = "${local.service_url["meetings"]}/tasks/purge_media"
    }
  }

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# The notetaker's reconcile (services/meetings/src/tasks/reconcile.js): every
# 15 minutes it picks up work whose own task was lost: webhooks never
# processed, bots never sent, recordings whose ingest never ran, and bots
# silent for hours. Called as purge_media is. A run with failures answers 500,
# which Cloud Scheduler records; the next run tries again.
# ---------------------------------------------------------------------------
resource "google_cloud_scheduler_job" "meetings_reconcile" {
  project          = var.project_id
  region           = var.region
  name             = "meetings-reconcile"
  description      = "Re-drives notetaker work whose task was lost (meetings /tasks/reconcile)."
  schedule         = "*/15 * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "300s"

  retry_config {
    retry_count = 0 # the next tick is the retry
  }

  http_target {
    http_method = "POST"
    uri         = "${local.service_url["meetings"]}/tasks/reconcile"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode(jsonencode({ kind = "reconcile" }))

    oidc_token {
      service_account_email = google_service_account.runtime["run-jobs"].email
      audience              = "${local.service_url["meetings"]}/tasks/reconcile"
    }
  }

  depends_on = [google_project_service.apis]
}

# ---------------------------------------------------------------------------
# Billing's Apple reconcile (services/billing/src/tasks/reconcile-apple.js):
# every hour it asks Apple (App Store Server API) about the App Store
# subscriptions near the end of their period, or not checked for a week, so a
# notification that never arrived can't leave an entitlement wrong.
#
# Called as Cloud Tasks call a task (@algominutes/ai/task-auth.cjs): an OIDC
# token issued to run-jobs, for exactly this URL. No retries: the next tick is
# the retry. Until the owner adds the key it checks nothing.
# ---------------------------------------------------------------------------
resource "google_cloud_scheduler_job" "billing_reconcile_apple" {
  project          = var.project_id
  region           = var.region
  name             = "billing-reconcile-apple"
  description      = "Checks App Store subscriptions with Apple, for notifications that never arrived (billing /tasks/reconcile-apple)."
  schedule         = "17 * * * *"
  time_zone        = "Etc/UTC"
  attempt_deadline = "90s" # billing answers within its 60 s request timeout

  retry_config {
    retry_count = 0 # the next tick is the retry
  }

  http_target {
    http_method = "POST"
    uri         = "${local.service_url["billing"]}/tasks/reconcile-apple"
    headers     = { "Content-Type" = "application/json" }
    body        = base64encode(jsonencode({ kind = "reconcile-apple" }))

    oidc_token {
      service_account_email = google_service_account.runtime["run-jobs"].email
      audience              = "${local.service_url["billing"]}/tasks/reconcile-apple"
    }
  }

  depends_on = [google_project_service.apis]
}
