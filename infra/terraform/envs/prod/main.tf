# ===========================================================================
# AlgoMinutes — PRODUCTION environment (thin caller)
# Same architecture as staging, on a modest dedicated tier with data-loss
# guards ON.
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
# Not committed (public repo). Derive at plan time:
#   export TF_VAR_billing_account=$(gcloud billing projects describe algominutes-prod \
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

  env            = "prod"
  project_id     = var.project_id
  project_number = var.project_number
  region         = var.region

  # Modest dedicated tier.
  connection_budget         = jsondecode(file("${path.module}/connection-budget.json"))
  db_tier                   = "db-custom-1-3840" # 1 vCPU / 3.75 GB
  db_edition                = var.db_edition
  db_disk_size_gb           = 20
  db_point_in_time_recovery = true
  deletion_protection       = true

  recordings_lifecycle_days = 0     # keep prod recordings (no lifecycle delete)
  bucket_force_destroy      = false # never blow away prod buckets

  firestore_deletion_policy = "ABANDON"

  # Placeholder until prod is provisioned (plan PR-35): set it from staging's
  # measured gross cost plus expected traffic, and record the figure in DECISIONS.
  # Keyless deploys: only the main branch's jobs in the `production`
  # GitHub Environment may impersonate gha-deployer (public repo).
  wif_allowed_refs       = ["refs/heads/main"]
  wif_github_environment = "production"

  billing_account = var.billing_account
  alert_emails    = var.alert_emails

  # The api's CORS allowlist (the public site) and its operator/kill-switch
  # settings. A blank allowed_origins fails the plan (the api can't boot on it).
  allowed_origins   = "https://algominutes.algorythmos.com"
  admin_uids        = var.admin_uids
  broadcast_capture = var.broadcast_capture
  monthly_budget    = 300
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
