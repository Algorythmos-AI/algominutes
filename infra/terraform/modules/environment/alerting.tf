# ---------------------------------------------------------------------------
# Alerts on the failures that are otherwise silent (plan PR-16c, first slice).
#
# CLAUDE.md §2: "Silent message loss is the worst failure mode", and BLOCKERS:
# a permanently failing purge or account deletion "must page someone". Each
# event below is already a structured log line (@algominutes/ai/logger.cjs:
# the event name is jsonPayload.msg). A log-based counter turns it into a
# metric, and a policy emails var.alert_emails when it fires.
#
# No suppression (CLAUDE.md §4.8): a stuck purge is re-logged by every sweep
# run (every 15 min), so its alert stays open until it's fixed.
#
# Emails are passed at plan time (TF_VAR_alert_emails), never committed. With
# none, the policies still open incidents in the console but email nobody.
# ---------------------------------------------------------------------------

locals {
  # event (jsonPayload.msg) => when to alert. `threshold`: count above which
  # the alert fires within `window`.
  log_alerts = {
    storage_purge_stuck = {
      threshold = 0
      window    = "900s"
      severity  = "ERROR"
      doc       = "A note or account purge failed 10 times and is no longer retried: a deleted note's doc or audio still exists. See the sweep's storage_purge_stuck log line (purgeId, noteId, lastError) and runbook 'Deletion'."
    }
    delete_account_incomplete = {
      threshold = 0
      window    = "900s"
      severity  = "ERROR"
      doc       = "An account deletion couldn't finish outside Postgres (purges, mirror docs or storage). The Auth user is kept so a retry can finish; the sweep retries every 15 min. See delete_account_incomplete (userId, errors)."
    }
    sweep_step_failed = {
      threshold = 0
      window    = "900s"
      severity  = "ERROR"
      doc       = "A db-sweep step failed (the job exits non-zero). See sweep_step_failed (step, err)."
    }
    dead_letter_recorded = {
      threshold = 0
      window    = "600s"
      severity  = "ERROR"
      doc       = "A task was dead-lettered after its last attempt. Review it in the admin view (GET /v1/admin/dead-letters) and resolve it."
    }
    note_failed = {
      threshold = 2
      window    = "1800s"
      severity  = "WARNING"
      doc       = "More than two notes failed in 30 minutes. See note_failed (noteId, reason) and the transcoder/summarizer logs under the same traceId."
    }
    gemini_model_unavailable = {
      threshold = 0
      window    = "3600s"
      severity  = "ERROR"
      doc       = "A Gemini ladder rung answered 'not found / unavailable' in this region (retired or not served). Check @algominutes/ai/models.cjs against Vertex model lifecycle; the ladder falls through to the next rung meanwhile."
    }
    auth_account_check_failed = {
      threshold = 0
      window    = "300s"
      severity  = "ERROR"
      doc       = "The api or billing couldn't reach Postgres to admit a caller, so it answered 503. Check Cloud SQL, the VPC connector and the connection budget."
    }
    readiness_db_unreachable = {
      threshold = 0
      window    = "300s"
      severity  = "ERROR"
      doc       = "/health/ready couldn't reach Postgres. Check Cloud SQL, the VPC connector and the connection budget."
    }
  }
}

resource "google_monitoring_notification_channel" "email" {
  for_each = toset(var.alert_emails)

  project      = var.project_id
  display_name = "algominutes-${var.env} alerts: ${each.value}"
  type         = "email"
  labels       = { email_address = each.value }

  depends_on = [google_project_service.apis]
}

resource "google_logging_metric" "event" {
  for_each = local.log_alerts

  project     = var.project_id
  name        = "algominutes_${each.key}"
  description = "Count of '${each.key}' log lines from Cloud Run services and jobs."
  filter      = "(resource.type=\"cloud_run_revision\" OR resource.type=\"cloud_run_job\") AND jsonPayload.msg=\"${each.key}\""

  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "event" {
  for_each = local.log_alerts

  project      = var.project_id
  display_name = "algominutes-${var.env}: ${each.key}"
  combiner     = "OR"
  severity     = each.value.severity

  # Monitoring refuses an alert filter with no resource.type (the first staging
  # apply failed on every one), and a log-based metric's series carry the
  # resource of the line that made them: a Cloud Run service's, or a job's
  # (db-job, db-sweep). So one condition per resource type, either one firing.
  dynamic "conditions" {
    for_each = ["cloud_run_revision", "cloud_run_job"]
    content {
      display_name = "${each.key} > ${each.value.threshold} in ${each.value.window} (${conditions.value})"
      condition_threshold {
        filter          = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.event[each.key].name}\" AND resource.type=\"${conditions.value}\""
        comparison      = "COMPARISON_GT"
        threshold_value = each.value.threshold
        duration        = "0s"
        aggregations {
          alignment_period     = each.value.window
          per_series_aligner   = "ALIGN_SUM"
          cross_series_reducer = "REDUCE_SUM"
        }
        trigger {
          count = 1
        }
      }
    }
  }

  documentation {
    content   = each.value.doc
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "3600s"
  }

  notification_channels = [for c in google_monitoring_notification_channel.email : c.id]
}

# 5xx from the public HTTP services (api, billing), from Cloud Run's own
# request metric, so it fires even when the app can't log.
resource "google_monitoring_alert_policy" "http_5xx" {
  project      = var.project_id
  display_name = "algominutes-${var.env}: api/billing 5xx"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "more than 5 5xx responses in 5 minutes"
    condition_threshold {
      filter          = "metric.type=\"run.googleapis.com/request_count\" AND resource.type=\"cloud_run_revision\" AND metric.label.response_code_class=\"5xx\" AND (resource.label.service_name=\"api\" OR resource.label.service_name=\"billing\")"
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      duration        = "0s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.service_name"]
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "The api or billing answered more than five 5xx in 5 minutes. Look at the service's ERROR logs for the same window (every line carries traceId)."
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "3600s"
  }

  notification_channels = [for c in google_monitoring_notification_channel.email : c.id]

  depends_on = [google_project_service.apis]
}
