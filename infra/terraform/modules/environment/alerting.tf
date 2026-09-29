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
    # The notetaker (RELEASE.md PR 19). The purge worker re-logs an exhausted purge every 30 minutes, so the
    # alert stays open until a person acts.
    recall_purge_exhausted = {
      threshold = 0
      window    = "1800s"
      severity  = "ERROR"
      doc       = "Recall's copy of a notetaker recording wasn't confirmed deleted after 10 attempts. See recall_purge_exhausted (recallBotId, reason, traceId) and the recall_media_delete_failed lines under the same traceId. Recall's 72-hour retention deletes it regardless; delete it by hand (POST /api/v1/bot/{id}/delete_media/) and confirm the recall_purges row."
    }
    notetaker_media_never_arrived = {
      threshold = 0
      window    = "900s"
      severity  = "ERROR"
      doc       = "A notetaker recorded a meeting but its media never reached us in 6 hours, so its note failed (nothing charged, Recall's copy queued to go). See notetaker_media_never_arrived (meetingBotId, noteId, endedAt): check Recall's status for the bot and the webhook endpoint (an endpoint Recall disabled stops every event)."
    }
    notetaker_reconcile_step_failed = {
      threshold = 0
      window    = "1800s"
      severity  = "ERROR"
      doc       = "A whole step of the notetaker reconcile failed (it couldn't read what to re-drive): the steps after it still ran, this one didn't. See notetaker_reconcile_step_failed (step, err): usually Postgres."
    }
    cancel_bot_gave_up = {
      threshold = 0
      window    = "900s"
      severity  = "ERROR"
      doc       = "A user's cancel of a notetaker couldn't reach Recall in 5 attempts (dead-lettered). A bot already recording keeps recording until its reservation runs out: make it leave by hand (POST /api/v1/bot/{id}/leave_call/) and see cancel_bot_gave_up (meetingBotId, err)."
    }
    notetaker_reconcile_item_failed = {
      threshold = 2
      window    = "3600s"
      severity  = "WARNING"
      doc       = "The notetaker reconcile couldn't re-drive some work more than twice in an hour. See notetaker_reconcile_item_failed (meetingBotId or recallEventId, err): usually Recall or the queue unreachable."
    }
    notetaker_ingest_gave_up = {
      threshold = 0
      window    = "900s"
      severity  = "ERROR"
      doc       = "A notetaker recording couldn't be made ours in 5 attempts: its note failed (or, if its run was already queued, only Recall's copy was left to the purge worker). See notetaker_ingest_gave_up (noteId, meetingBotId, err) and the notetaker_ingest_attempt_failed lines under the same traceId."
    }
    notetaker_ingested_audio_missing = {
      threshold = 0
      window    = "900s"
      severity  = "ERROR"
      doc       = "A notetaker recording was ingested but its audio object is gone from the recordings bucket, so its note can't run. See notetaker_ingested_audio_missing (noteId, storagePath) and the ingest's traceId."
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
    gemini_transient = {
      threshold = 20
      window    = "900s"
      severity  = "WARNING"
      doc       = "Gemini answered overloaded (429/503) more than 20 times in 15 minutes. From 2026-10-20 the ladder has one Sydney model, so the summarize queue retries for about an hour before a note fails. Check Vertex status for australia-southeast1 and the gemini_transient lines (model, attempt); if it persists, consider Provisioned Throughput (DECISIONS 2026-09-28)."
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

    # RELEASE.md PR 15b.
    # A task out of attempts whose failure could be lost: its dead letter wasn't written, or its note wasn't
    # marked failed (the user sees it stuck). dead_letter_recorded, above, covers the ones that were.
    dead_letter_record_failed = {
      threshold = 0
      window    = "300s"
      severity  = "ERROR"
      doc       = "A task ran out of attempts and its dead letter couldn't be written: the failure is only in this log line (CLAUDE.md §2). See dead_letter_record_failed (noteId, queue, err), fix the cause, and re-drive or fail the note by hand."
    }
    sweep_dead_letter_failed = {
      threshold = 0
      window    = "900s"
      severity  = "ERROR"
      doc       = "The sweep couldn't dead-letter a note it gave up on. See sweep_dead_letter_failed (noteId, err)."
    }
    transcoder_last_attempt_dead_letter_only = {
      threshold = 0
      window    = "600s"
      severity  = "ERROR"
      doc       = "A transcode ran out of attempts and was dead-lettered, but its note couldn't be marked failed (reason: postgres_error, missing_ids or note_not_failed): the user sees it stuck. Review it in the admin view; the sweep fails a stuck note after STUCK_NOTE_MS."
    }
    summarizer_last_attempt_dead_letter_only = {
      threshold = 0
      window    = "600s"
      severity  = "ERROR"
      doc       = "A summary ran out of attempts and was dead-lettered, but its note couldn't be marked failed: the user sees it stuck. Review it in the admin view; the sweep fails a stuck note after STUCK_NOTE_MS."
    }
    # SLO 4 (docs/SLO.md): the summarizer logs a pipeline run slower than half its recording's length plus 5 min.
    time_to_summary_slo_missed = {
      threshold = 2
      window    = "3600s"
      severity  = "WARNING"
      doc       = "More than two recordings in an hour took longer than SLO 4 allows (half the recording's length plus 5 minutes). See time_to_summary_slo_missed (noteId, timeToSummarySec, recordingSec, objectiveSec) and the run's traceId: queue backlog, STT latency or Gemini retries (gemini_transient)."
    }
    # The daily spend cap (DAILY_SPEND_CAP_AUD): at 80%, and reached (every recording is then refused until the
    # day turns, with its minutes refunded).
    spend_cap_approaching = {
      threshold = 0
      window    = "3600s"
      severity  = "WARNING"
      doc       = "Today's paid audio has passed 80% of DAILY_SPEND_CAP_AUD. At the cap, every new recording is refused (and refunded) until tomorrow. Decide whether to raise the cap (Terraform daily_spend_cap_aud)."
    }
    spend_cap_tripped = {
      threshold = 0
      window    = "3600s"
      severity  = "ERROR"
      doc       = "The daily spend cap was reached: recordings are refused, with their minutes refunded, until the day turns. See spend_cap_tripped (spent, cap). Raise daily_spend_cap_aud and apply if it's real use; look for a runaway if it isn't."
    }
    # The sweep found pipeline work lost after its claim and enqueued it again (RELEASE.md PR 5c): recovered,
    # but something lost it.
    lost_work_redriven = {
      threshold = 0
      window    = "3600s"
      severity  = "WARNING"
      doc       = "The sweep re-drove a summary or an embed whose task was lost after its claim (lost_work_redriven: noteId, worker). The note recovers; find why the task was lost (redrive_enqueue_failed, chunk_complete_enqueue_failed, a crash) under the note's traceId."
    }
    # Someone asked for help in the app (Settings → Help & Support, or a bad transcript/summary report).
    support_request_created = {
      threshold = 0
      window    = "300s"
      severity  = "WARNING"
      doc       = "A user sent a support request. Find it by id: SELECT * FROM support_requests WHERE id = '<supportId>'. Answer within one working day (docs/runbooks/testflight-internal.md, Triage feedback)."
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
