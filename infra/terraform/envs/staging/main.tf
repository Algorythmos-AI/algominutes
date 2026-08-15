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

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

module "environment" {
  source = "../../modules/environment"

  env            = "staging"
  project_id     = var.project_id
  project_number = var.project_number
  region         = var.region

  # Smallest viable tiers. db-f1-micro is shared-core → requires ENTERPRISE
  # edition (set in tfvars); ENTERPRISE_PLUS rejects it.
  db_tier                   = "db-f1-micro"
  db_edition                = var.db_edition
  db_disk_size_gb           = 10
  db_point_in_time_recovery = false
  deletion_protection       = false

  recordings_lifecycle_days = 7    # 7-day retention on staging recordings
  bucket_force_destroy      = true # staging is disposable

  firestore_deletion_policy = "DELETE"
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
