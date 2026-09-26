# ---------------------------------------------------------------------------
# Budget + alerts for this environment's project (plan PR-08c).
#
# GROSS cost, credits excluded. On the free trial the net bill is $0 until the
# credit is gone, so a net-cost budget stays silent while the credit burns and
# the first alert would be the first real bill. Gross cost is also exactly
# what this environment will cost once it is on paid billing.
#
# Alerts: actual spend at var.budget_alert_thresholds of var.monthly_budget,
# plus a forecast at 100% (warns early in the month). Emails go to the billing
# account's admins/users (default IAM recipients) and to any Cloud Monitoring
# channels in var.budget_notification_channels.
#
# The Budgets API needs a quota project when Terraform runs on user ADC, so this
# resource uses the `google.billing` provider alias (user_project_override),
# leaving every other resource on the default provider. The billing account ID
# is passed at plan time, never committed (runbook §1).
# ---------------------------------------------------------------------------
resource "google_billing_budget" "env" {
  provider        = google.billing
  billing_account = var.billing_account
  display_name    = "algominutes-${var.env} monthly (gross)"

  budget_filter {
    projects               = ["projects/${var.project_number}"]
    credit_types_treatment = "EXCLUDE_ALL_CREDITS"
    calendar_period        = "MONTH"
  }

  amount {
    specified_amount {
      # Currency omitted: it is the billing account's (AUD).
      units = tostring(var.monthly_budget)
    }
  }

  dynamic "threshold_rules" {
    for_each = var.budget_alert_thresholds
    content {
      threshold_percent = threshold_rules.value
      spend_basis       = "CURRENT_SPEND"
    }
  }

  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    monitoring_notification_channels = var.budget_notification_channels
    disable_default_iam_recipients   = false
  }

  depends_on = [google_project_service.apis]
}
