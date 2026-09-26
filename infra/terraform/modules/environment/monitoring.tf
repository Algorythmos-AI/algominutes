# ---------------------------------------------------------------------------
# Uptime check on the api, and one dashboard for the pipeline (plan PR-16c).
# Alerts on specific failures live in alerting.tf; this is "is it up" and
# "what is it doing".
# ---------------------------------------------------------------------------

locals {
  api_host = trimprefix(google_cloud_run_v2_service.services["api"].uri, "https://")
}

# GET /v1/health: no auth, no version gate, no database (routes/index.js), so it
# measures the service itself. Every 5 minutes from several regions.
resource "google_monitoring_uptime_check_config" "api" {
  project      = var.project_id
  display_name = "algominutes-${var.env}: api /v1/health"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path         = "/v1/health"
    port         = 443
    use_ssl      = true
    validate_ssl = true
    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  content_matchers {
    content = "\"status\":\"ok\""
    matcher = "CONTAINS_STRING"
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = local.api_host
    }
  }

  depends_on = [google_project_service.apis]
}

# Down when the check fails from more than one region for two periods running
# (one region's blip is not an outage).
resource "google_monitoring_alert_policy" "api_uptime" {
  project      = var.project_id
  display_name = "algominutes-${var.env}: api down (/v1/health)"
  combiner     = "OR"
  severity     = "CRITICAL"

  conditions {
    display_name = "/v1/health failing from more than one region"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=\"${google_monitoring_uptime_check_config.api.uptime_check_id}\" AND resource.type=\"uptime_url\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "The api's /v1/health has failed from more than one region for 10 minutes. Check the api service's revisions and logs, and whether a deploy is in progress."
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "3600s"
  }

  notification_channels = [for c in google_monitoring_notification_channel.email : c.id]
}

locals {
  # One time-series tile. `filter` selects the series; the rest aggregates it.
  dash_tile = {
    for k, t in {
      api_requests = {
        title   = "api requests by response class"
        filter  = "metric.type=\"run.googleapis.com/request_count\" resource.type=\"cloud_run_revision\" resource.label.service_name=\"api\""
        aligner = "ALIGN_RATE"
        reducer = "REDUCE_SUM"
        group   = ["metric.label.response_code_class"]
      }
      api_latency_p95 = {
        title   = "api latency p95 (ms)"
        filter  = "metric.type=\"run.googleapis.com/request_latencies\" resource.type=\"cloud_run_revision\" resource.label.service_name=\"api\""
        aligner = "ALIGN_PERCENTILE_95"
        reducer = "REDUCE_MAX"
        group   = []
      }
      worker_requests = {
        title   = "pipeline workers: requests by service and class"
        filter  = "metric.type=\"run.googleapis.com/request_count\" resource.type=\"cloud_run_revision\" (resource.label.service_name=\"transcoder\" OR resource.label.service_name=\"summarizer\" OR resource.label.service_name=\"embedder\")"
        aligner = "ALIGN_RATE"
        reducer = "REDUCE_SUM"
        group   = ["resource.label.service_name", "metric.label.response_code_class"]
      }
      queue_depth = {
        title   = "Cloud Tasks queue depth"
        filter  = "metric.type=\"cloudtasks.googleapis.com/queue/depth\" resource.type=\"cloud_tasks_queue\""
        aligner = "ALIGN_MEAN"
        reducer = "REDUCE_SUM"
        group   = ["resource.label.queue_id"]
      }
      notes_failed = {
        title   = "notes failed (note_failed)"
        filter  = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.event["note_failed"].name}\""
        aligner = "ALIGN_SUM"
        reducer = "REDUCE_SUM"
        group   = []
      }
      dead_letters = {
        title   = "tasks dead-lettered (dead_letter_recorded)"
        filter  = "metric.type=\"logging.googleapis.com/user/${google_logging_metric.event["dead_letter_recorded"].name}\""
        aligner = "ALIGN_SUM"
        reducer = "REDUCE_SUM"
        group   = []
      }
      sql_cpu = {
        title   = "Cloud SQL CPU utilisation"
        filter  = "metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\" resource.type=\"cloudsql_database\""
        aligner = "ALIGN_MEAN"
        reducer = "REDUCE_MAX"
        group   = []
      }
      sql_connections = {
        title   = "Cloud SQL connections"
        filter  = "metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\" resource.type=\"cloudsql_database\""
        aligner = "ALIGN_MEAN"
        reducer = "REDUCE_SUM"
        group   = []
      }
    } : k => t
  }
  dash_order = ["api_requests", "api_latency_p95", "worker_requests", "queue_depth", "notes_failed", "dead_letters", "sql_cpu", "sql_connections"]
}

# The public site (apps/site on Vercel): each page the apps and the stores
# link to answers 200 with its heading. One environment watches it
# (site_uptime_host; staging until prod exists, then prod), every 5 minutes.
locals {
  site_pages = var.site_uptime_host == "" ? {} : {
    home           = { path = "/", content = "Every meeting, summed up" }
    privacy        = { path = "/privacy", content = "Privacy Policy" }
    terms          = { path = "/terms", content = "Terms of Service" }
    support        = { path = "/support", content = "Support" }
    delete-account = { path = "/delete-account", content = "Delete your AlgoMinutes account" }
  }
}

resource "google_monitoring_uptime_check_config" "site" {
  for_each     = local.site_pages
  project      = var.project_id
  display_name = "algominutes site: ${each.value.path}"
  timeout      = "10s"
  period       = "300s"

  http_check {
    path         = each.value.path
    port         = 443
    use_ssl      = true
    validate_ssl = true
    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  content_matchers {
    content = each.value.content
    matcher = "CONTAINS_STRING"
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = var.site_uptime_host
    }
  }

  depends_on = [google_project_service.apis]
}

# Any page failing from more than one region for two periods running: the
# store listings' Privacy, Support and deletion URLs are down.
locals {
  site_check_ids = join("|", [for c in google_monitoring_uptime_check_config.site : c.uptime_check_id])
}

resource "google_monitoring_alert_policy" "site_uptime" {
  count        = var.site_uptime_host == "" ? 0 : 1
  project      = var.project_id
  display_name = "algominutes site down (${var.site_uptime_host})"
  combiner     = "OR"
  severity     = "ERROR"

  conditions {
    display_name = "a public page failing from more than one region"
    condition_threshold {
      filter          = "metric.type=\"monitoring.googleapis.com/uptime_check/check_passed\" AND metric.label.check_id=monitoring.regex.full_match(\"${local.site_check_ids}\") AND resource.type=\"uptime_url\""
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      duration        = "600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["metric.label.check_id"]
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "A page of ${var.site_uptime_host} has failed from more than one region for 10 minutes. The App Store and Google Play link to these pages. See docs/runbooks/site.md: check the Vercel project algominutes-site's latest Production deployment, roll back to the previous one if it's the cause, and check the Cloudflare CNAME."
    mime_type = "text/markdown"
  }

  alert_strategy {
    auto_close = "3600s"
  }

  notification_channels = [for c in google_monitoring_notification_channel.email : c.id]
}

resource "google_monitoring_dashboard" "pipeline" {
  project = var.project_id
  dashboard_json = jsonencode({
    displayName = "algominutes-${var.env}: pipeline"
    mosaicLayout = {
      columns = 12
      tiles = [
        for i, k in local.dash_order : {
          xPos   = (i % 2) * 6
          yPos   = floor(i / 2) * 4
          width  = 6
          height = 4
          widget = {
            title = local.dash_tile[k].title
            xyChart = {
              dataSets = [{
                plotType = "LINE"
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = local.dash_tile[k].filter
                    aggregation = merge(
                      {
                        alignmentPeriod    = "60s"
                        perSeriesAligner   = local.dash_tile[k].aligner
                        crossSeriesReducer = local.dash_tile[k].reducer
                      },
                      length(local.dash_tile[k].group) > 0 ? { groupByFields = local.dash_tile[k].group } : {},
                    )
                  }
                }
              }]
            }
          }
        }
      ]
    }
  })

  depends_on = [google_project_service.apis]
}
