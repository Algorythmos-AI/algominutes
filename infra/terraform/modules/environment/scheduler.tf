# ---------------------------------------------------------------------------
# The periodic sweeper (plan PR-15): Cloud Scheduler runs the db-job Cloud Run
# Job with JOB_NAME=sweep (services/db-job/src/handlers/sweep.js). It retries
# storage purges, fails notes stuck in flight, drops expired upload sessions,
# finishes account deletions a client abandoned, and prunes old tombstones.
#
# The scheduler authenticates as run-scheduler, which may only run THIS job
# with overrides (the JOB_NAME env), nothing else.
# ---------------------------------------------------------------------------
resource "google_cloud_run_v2_job_iam_member" "scheduler_runs_db_job" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.db_job.name
  role     = "roles/run.jobsExecutorWithOverrides"
  member   = "serviceAccount:${google_service_account.runtime["run-scheduler"].email}"
}

resource "google_cloud_scheduler_job" "sweep" {
  count = var.enable_sweeper ? 1 : 0

  project          = var.project_id
  region           = var.region
  name             = "db-job-sweep"
  description      = "Runs db-job with JOB_NAME=sweep (storage purges, stuck notes, upload sessions, account deletions, tombstones)."
  schedule         = var.sweep_schedule
  time_zone        = "Etc/UTC"
  attempt_deadline = "60s" # starting the job; the sweep itself runs in the job (timeout 3600s)

  retry_config {
    retry_count = 0 # the next tick is the retry; the job is idempotent
  }

  http_target {
    http_method = "POST"
    uri         = "https://run.googleapis.com/v2/projects/${var.project_id}/locations/${var.region}/jobs/${google_cloud_run_v2_job.db_job.name}:run"
    headers     = { "Content-Type" = "application/json" }
    body = base64encode(jsonencode({
      overrides = { containerOverrides = [{ env = [{ name = "JOB_NAME", value = "sweep" }] }] }
    }))

    oauth_token {
      service_account_email = google_service_account.runtime["run-scheduler"].email
      scope                 = "https://www.googleapis.com/auth/cloud-platform"
    }
  }

  depends_on = [google_project_service.apis, google_cloud_run_v2_job_iam_member.scheduler_runs_db_job]
}
