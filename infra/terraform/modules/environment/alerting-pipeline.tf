# ---------------------------------------------------------------------------
# The pipeline's quiet failures (RELEASE.md rev 11, H7): each of these could stop or stall work with nothing
# logged as an error, so nothing else here would fire. Emails as alerting.tf's (var.alert_emails).
# ---------------------------------------------------------------------------

locals {
  alert_channels = [for c in google_monitoring_notification_channel.email : c.id]
}

# The sweep re-drives lost work and purges deleted data every 15 minutes, and logs sweep_done at the end of
# each run. Its failures alert already (sweep_step_failed); its absence didn't: a paused scheduler, a job that
# can't start, or a sweep held by SWEEPER_HOLD. 45 minutes is three missed runs.
resource "google_logging_metric" "sweep_done" {
  project     = var.project_id
  name        = "algominutes_sweep_done"
  description = "Count of sweep_done lines: one per completed sweep run."
  filter      = "resource.type=\"cloud_run_job\" AND jsonPayload.msg=\"sweep_done\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "sweep_absent" {
  project      = var.project_id
  display_name = "algominutes-${var.env}: the sweep hasn't finished a run in 45 minutes"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "no sweep_done for 45 min"
    condition_absent {
      filter   = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.sweep_done.name}\" AND resource.type=\"cloud_run_job\""
      duration = "2700s"
      aggregations {
        alignment_period     = "900s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "No sweep_done for 45 minutes: lost work isn't re-driven and deletions aren't purged. Check the db-sweep Scheduler job (paused? SWEEPER_HOLD?), then the db-sweep job's executions and their logs."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
}

# A Cloud Scheduler job that fails to run its target (the sweep, the notetaker's reconcile, billing's tasks)
# logs an ERROR on the job, not in any service.
resource "google_logging_metric" "scheduler_failed" {
  project     = var.project_id
  name        = "algominutes_scheduler_failed"
  description = "Count of Cloud Scheduler job errors (a target that failed or couldn't be reached)."
  filter      = "resource.type=\"cloud_scheduler_job\" AND severity>=ERROR"

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "scheduler_failed" {
  project      = var.project_id
  display_name = "algominutes-${var.env}: a Cloud Scheduler job failed"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "scheduler job errors > 0 in 1 h"
    condition_threshold {
      filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.scheduler_failed.name}\" AND resource.type=\"cloud_scheduler_job\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      duration        = "0s"
      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "A Cloud Scheduler job logged an error: its target failed or couldn't be reached. Logs: resource.type=\"cloud_scheduler_job\" severity>=ERROR (the job id is in the resource labels)."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
}

# Work piling up: a queue with more than 50 tasks waiting for 15 minutes (stuck workers, or more than the
# dispatch caps can drain).
resource "google_monitoring_alert_policy" "queue_backlog" {
  project      = var.project_id
  display_name = "algominutes-${var.env}: a task queue is backing up"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "queue depth > 50 for 15 min"
    condition_threshold {
      filter          = "metric.type=\"cloudtasks.googleapis.com/queue/depth\" AND resource.type=\"cloud_tasks_queue\""
      comparison      = "COMPARISON_GT"
      threshold_value = 50
      duration        = "900s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "A Cloud Tasks queue has held more than 50 tasks for 15 minutes. The queue id is in the incident. Check its worker's errors and instance count, and the dashboard's queue panels."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
}

# Cloud SQL near its limits: the dashboard showed these, and nothing alerted on them.
resource "google_monitoring_alert_policy" "sql_saturation" {
  project      = var.project_id
  display_name = "algominutes-${var.env}: Cloud SQL near its limits"
  combiner     = "OR"
  severity     = "WARNING"

  conditions {
    display_name = "CPU > 80% for 10 min"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${google_sql_database_instance.pg.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      duration        = "600s"
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MEAN"
      }
      trigger {
        count = 1
      }
    }
  }

  conditions {
    display_name = "connections > ${var.sql_connections_alert} for 10 min"
    condition_threshold {
      filter          = "metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\" AND resource.type=\"cloudsql_database\" AND resource.label.database_id=\"${var.project_id}:${google_sql_database_instance.pg.name}\""
      comparison      = "COMPARISON_GT"
      threshold_value = var.sql_connections_alert
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_MAX"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Cloud SQL's CPU or connections are near the instance's limits. On staging (db-f1-micro, 25 connections), this is the signal to size it up (RELEASE.md rev 11, H23)."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
}
