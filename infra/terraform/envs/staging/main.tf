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
  connection_budget         = jsondecode(file("${path.module}/connection-budget.json"))
  db_tier                   = "db-f1-micro"
  db_edition                = var.db_edition
  db_disk_size_gb           = 10
  db_point_in_time_recovery = false
  deletion_protection       = false

  recordings_lifecycle_days = 7    # 7-day retention on staging recordings
  bucket_force_destroy      = true # staging is disposable

  firestore_deletion_policy = "DELETE"

  # Idle staging (db-f1-micro + a 2-instance VPC connector) is well under this;
  # 50% is the "someone left something running" signal, forecast-100% the
  # early warning. Gross cost, so it fires while the trial credit burns.
  # Keyless deploys: only the integration branch's jobs in the `staging`
  # GitHub Environment may impersonate gha-deployer (public repo).
  wif_allowed_refs       = ["refs/heads/integration"]
  wif_github_environment = "staging"

  billing_account = var.billing_account
  alert_emails    = var.alert_emails
  monthly_budget  = 100

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
