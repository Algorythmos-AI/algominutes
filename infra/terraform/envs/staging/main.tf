# ===========================================================================
# AlgoMinutes — STAGING environment (thin caller)
# Staging mirrors production's architecture at the SMALLEST viable tier.
# ===========================================================================

terraform {
  required_version = ">= 1.9"

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

variable "project_id" {
  type = string
}
variable "project_number" {
  type = string
}
variable "region" {
  type    = string
  default = "australia-southeast1"
}
variable "db_edition" {
  type    = string
  default = "ENTERPRISE"
}
# Not committed (public repo). The runbook derives it at plan time:
#   export TF_VAR_billing_account=$(gcloud billing projects describe algominutes-staging \
#     --format='value(billingAccountName)' | sed 's#billingAccounts/##')
variable "billing_account" {
  type = string
}

# Who the alerts email (alerting.tf). Passed at plan time, never committed:
#   export TF_VAR_alert_emails='["you@example.com"]'
variable "alert_emails" {
  type    = list(string)
  default = []
}

# Operator uids for the api's /v1/admin/* routes (the dead-letter view). Firebase
# uids exist only once someone has signed in, so this is set on a later plan,
# never committed:
#   export TF_VAR_admin_uids='["<your uid>"]'
variable "admin_uids" {
  type    = list(string)
  default = []
}

# Broadcast capture's server-side kill switch (GET /v1/config). To turn it off
# without an app build: plan with TF_VAR_broadcast_capture=off and apply.
variable "broadcast_capture" {
  type    = string
  default = "on"
}

# The online-meeting notetaker's surfaces (GET /v1/config). Off unless named;
# for testers in notetaker_testers only. To switch the bot on for them: plan
# with TF_VAR_notetaker_surfaces=bot and apply.
variable "notetaker_surfaces" {
  type    = string
  default = ""
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

# The Budgets API rejects user ADC without a quota project. Scope the override
# to this alias (used only by the budget) so nothing else changes behaviour.
provider "google" {
  alias                 = "billing"
  project               = var.project_id
  region                = var.region
  user_project_override = true
  billing_project       = var.project_id
}

module "environment" {
  source = "../../modules/environment"
  providers = {
    google         = google
    google-beta    = google-beta
    google.billing = google.billing
  }

  env            = "staging"
  project_id     = var.project_id
  project_number = var.project_number
  region         = var.region

  # Smallest viable tiers. db-f1-micro is shared-core → requires ENTERPRISE
  # edition (set in tfvars); ENTERPRISE_PLUS rejects it.
  connection_budget = jsondecode(file("${path.module}/connection-budget.json"))
  db_tier           = "db-f1-micro"
  db_edition        = var.db_edition
  db_disk_size_gb   = 10
  # Staging carries the external beta's real notes (docs/plans/RELEASE.md,
  # Wave 1), so its data is kept like prod's: point-in-time recovery (7 days of
  # logs), deletion protection, recordings kept until the note or account is
  # deleted (DATA-RETENTION.md: no lifecycle delete), and neither the buckets
  # nor the Firestore database are destroyed with the stack.
  db_point_in_time_recovery = true
  deletion_protection       = true

  recordings_lifecycle_days = 0
  bucket_force_destroy      = false

  firestore_deletion_policy = "ABANDON"

  # Idle staging (db-f1-micro + a 2-instance VPC connector) is well under this;
  # 50% is the "someone left something running" signal, forecast-100% the
  # early warning. Gross cost, so it fires while the trial credit burns.
  # Keyless deploys: only the integration branch's jobs in the `staging`
  # GitHub Environment may impersonate gha-deployer (public repo).
  wif_allowed_refs       = ["refs/heads/integration"]
  wif_github_environment = "staging"

  billing_account = var.billing_account
  alert_emails    = var.alert_emails

  # The api's CORS allowlist (the public site; the web app's staging address,
  # staging.algominutes.algorythmos.com, behind Vercel Authentication; and the
  # beta's, beta.algominutes.algorythmos.com, public to the testers)
  # and its operator/kill-switch settings. A blank allowed_origins fails the
  # plan (the api can't boot on it).
  allowed_origins = "https://algominutes.algorythmos.com,https://staging.algominutes.algorythmos.com,https://beta.algominutes.algorythmos.com"
  admin_uids      = var.admin_uids
  # The public site's uptime checks live here until prod exists (S3-PR4).
  site_uptime_host   = "algominutes.algorythmos.com"
  broadcast_capture  = var.broadcast_capture
  notetaker_surfaces = var.notetaker_surfaces

  # The external beta (RELEASE.md, Wave 1): new users get minutes from an invite
  # code, not the reverse trial. On again once Apple DeviceCheck is set up here
  # (RELEASE.md PR 22: devicecheck_key_id, apple_team_id and the devicecheck-key
  # secret), so a reinstall can't start a fresh one.
  trial_on_first_use = "off"
  # About 1,600 minutes a day at the default A$0.03 a minute (a cohort of 25
  # testers); A$20, the default, is about 660. The owner's figure.
  daily_spend_cap_aud = 50
  # Alerts only (budget.tf); the owner's figure.
  monthly_budget = 250

  # In-VPC proof VM for proving staging (docs/runbooks/staging-proof.md).
  # About US$15/month while on; set false and apply to remove it.
  enable_bastion = true
}

# Re-export module outputs at the root for convenience.
output "sql_instance_connection_name" {
  value = module.environment.sql_instance_connection_name
}
output "sql_private_ip" {
  value = module.environment.sql_private_ip
}
output "bucket_names" {
  value = module.environment.bucket_names
}
output "queue_ids" {
  value = module.environment.queue_ids
}
output "service_account_emails" {
  value = module.environment.service_account_emails
}
output "vpc_connector_id" {
  value = module.environment.vpc_connector_id
}
output "bastion_ssh_command" {
  value = module.environment.bastion_ssh_command
}
output "db_password_secret_id" {
  value = module.environment.db_password_secret_id
}

# What runbook §3 reads to wire the deploy workflow (repo variables
# GCP_WIF_PROVIDER / GCP_DEPLOYER_SA), plus the service URLs and the job name.
output "wif_provider_name" {
  value = module.environment.wif_provider_name
}
output "deployer_service_account_email" {
  value = module.environment.deployer_service_account_email
}
output "cloud_run_service_urls" {
  value = module.environment.cloud_run_service_urls
}
output "db_job_name" {
  value = module.environment.db_job_name
}
