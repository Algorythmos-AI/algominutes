# ---------------------------------------------------------------------------
# environment module — input variables
# One reusable module provisions a full AlgoMinutes environment (staging|prod).
# ---------------------------------------------------------------------------

variable "env" {
  description = "Environment short name — used in every resource name (e.g. algominutes-<env>-recordings). Must be 'staging' or 'prod'."
  type        = string
  validation {
    condition     = contains(["staging", "prod"], var.env)
    error_message = "env must be either 'staging' or 'prod'."
  }
}

variable "project_id" {
  description = "GCP project ID (permanent). e.g. algominutes-staging / algominutes-prod."
  type        = string
}

variable "project_number" {
  description = "GCP project number (permanent). Recorded for reference / future service-agent bindings."
  type        = string
}

variable "region" {
  description = "GCP region for ALL resources. AlgoMinutes is Sydney-only."
  type        = string
  default     = "australia-southeast1"
}

# --- Cloud SQL ---------------------------------------------------------------

variable "db_tier" {
  description = "Cloud SQL machine tier. staging: db-f1-micro (smallest viable). prod: a dedicated tier e.g. db-custom-1-3840."
  type        = string
}

variable "db_edition" {
  description = "Cloud SQL edition. ENTERPRISE allows shared-core tiers (db-f1-micro); ENTERPRISE_PLUS (Google's new default) rejects them. Set per env in tfvars, not hardcoded."
  type        = string
  default     = "ENTERPRISE"
  validation {
    condition     = contains(["ENTERPRISE", "ENTERPRISE_PLUS"], var.db_edition)
    error_message = "db_edition must be ENTERPRISE or ENTERPRISE_PLUS."
  }
}

variable "db_disk_size_gb" {
  description = "Cloud SQL data disk size in GB (PD_SSD, autoresizes upward)."
  type        = number
}

variable "db_point_in_time_recovery" {
  description = "Enable Postgres point-in-time recovery (WAL archiving). prod = true, staging = false."
  type        = bool
}

variable "deletion_protection" {
  description = "Guard Cloud SQL (and other stateful resources) against terraform destroy. prod = true, staging = false."
  type        = bool
}

variable "db_activation_policy" {
  description = "Cloud SQL run state. ALWAYS = running (normal). NEVER = stopped (pause via Terraform instead of an out-of-band gcloud patch — see the 2026-08-27 staging pause in docs/DECISIONS.md)."
  type        = string
  default     = "ALWAYS"
  validation {
    condition     = contains(["ALWAYS", "NEVER"], var.db_activation_policy)
    error_message = "db_activation_policy must be ALWAYS or NEVER."
  }
}

# --- Cloud Tasks -------------------------------------------------------------

variable "task_max_attempts" {
  description = "Max Cloud Tasks delivery attempts per queue. Single source of truth: services are deployed with MAX_TASK_ATTEMPTS set to this same value so the DLQ write fires on the true last attempt."
  type        = number
  default     = 5
}

# --- Cloud Run ---------------------------------------------------------------

variable "connection_budget" {
  description = "Postgres connection budget, from envs/<env>/connection-budget.json: per service its max instances (also a cost guard), pool count and PG_POOL_MAX, plus each job's connections. The worst case must fit the tier (precondition on the Cloud SQL instance)."
  type = object({
    tier              = string
    max_connections   = number
    reserved          = number
    operator_headroom = number
    services = map(object({
      max_instances = number
      pools         = number
      pool_max      = number
    }))
    jobs = map(object({
      connections = number
      pool_max    = number
    }))
  })
}

variable "allowed_origins" {
  description = "Comma-separated CORS allowlist for services/api (ALLOWED_ORIGINS). Set per env in tfvars once the web origin is confirmed; empty falls back to the api's baked-in localhost/capacitor allowlist."
  type        = string
  default     = ""
}

variable "enable_nat" {
  description = "Provision Cloud NAT so Cloud Run can reach third-party STT endpoints (AssemblyAI/Deepgram) over the connector. Off until diarisation go-live (PR-28); its monthly cost is recorded in docs/DECISIONS.md when enabled."
  type        = bool
  default     = false
}

variable "github_repo" {
  description = "owner/repo allowed to mint deploy tokens via Workload Identity Federation (keyless CI deploys). Only this repo's Actions can impersonate the deployer SA."
  type        = string
  default     = "Algorythmos-AI/algominutes"
}

# --- Cloud Storage -----------------------------------------------------------

variable "recordings_lifecycle_days" {
  description = "Delete objects in the recordings bucket after N days. staging = 7. prod = 0 (0 disables the lifecycle rule; recordings are kept)."
  type        = number
  default     = 0
}

variable "bucket_force_destroy" {
  description = "Allow `terraform destroy` to delete non-empty buckets. staging = true, prod = false."
  type        = bool
  default     = false
}

# --- Firestore ---------------------------------------------------------------

variable "firestore_deletion_policy" {
  description = "Deletion policy for the Firestore database. prod = ABANDON (never let terraform delete it). staging = DELETE."
  type        = string
  default     = "ABANDON"
  validation {
    condition     = contains(["DELETE", "ABANDON"], var.firestore_deletion_policy)
    error_message = "firestore_deletion_policy must be DELETE or ABANDON."
  }
}

# --- Networking (VPC connector sizing) --------------------------------------
# The connector has no true "free" tier; e2-micro with 2 instances is the floor.
# Kept identical across envs because Cloud Run egress correctness (private IP to
# Cloud SQL + Vertex reached only via the VPC) does not scale down safely.

variable "vpc_connector_machine_type" {
  description = "Serverless VPC Access connector machine type."
  type        = string
  default     = "e2-micro"
}

variable "vpc_connector_min_instances" {
  description = "Minimum connector instances (floor is 2)."
  type        = number
  default     = 2
}

variable "vpc_connector_max_instances" {
  description = "Maximum connector instances (must be > min; floor is 3)."
  type        = number
  default     = 3
}

# --- Network CIDRs -----------------------------------------------------------
# Defaults are non-overlapping and identical per env because each env is its
# own project (and thus its own VPC) — there is no cross-env peering.

variable "subnet_cidr" {
  description = "Primary regional subnet CIDR (private Google access on)."
  type        = string
  default     = "10.8.0.0/24"
}

variable "connector_cidr" {
  description = "Dedicated /28 for the Serverless VPC Access connector. Must NOT overlap subnet_cidr."
  type        = string
  default     = "10.8.1.0/28"
}

# ---------------------------------------------------------------------------
# Budget + alerts (budget.tf)
# ---------------------------------------------------------------------------
variable "billing_account" {
  description = "Billing account ID the project bills to (XXXXXX-XXXXXX-XXXXXX). Required: every environment gets a budget. Not committed; pass TF_VAR_billing_account (runbook)."
  type        = string

  validation {
    condition     = can(regex("^[0-9A-F]{6}-[0-9A-F]{6}-[0-9A-F]{6}$", var.billing_account))
    error_message = "billing_account must look like XXXXXX-XXXXXX-XXXXXX (see the runbook: derive it with gcloud billing projects describe)."
  }
}

variable "alert_emails" {
  description = "Email addresses the alert policies notify (alerting.tf). Passed at plan time (TF_VAR_alert_emails), never committed. Empty: incidents open in the console but nobody is emailed."
  type        = list(string)
  default     = []

  validation {
    condition     = alltrue([for e in var.alert_emails : can(regex("^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$", e))])
    error_message = "alert_emails must be email addresses."
  }
}

variable "monthly_budget" {
  description = "Monthly GROSS cost budget for this project, in the billing account's currency (AUD)."
  type        = number

  validation {
    condition     = var.monthly_budget > 0 && floor(var.monthly_budget) == var.monthly_budget
    error_message = "monthly_budget must be a positive whole number (the budget amount is whole currency units)."
  }
}

variable "budget_alert_thresholds" {
  description = "Fractions of monthly_budget (actual spend) that trigger an alert. A 100% forecast alert is always added."
  type        = list(number)
  default     = [0.5, 0.9, 1.0]
}

variable "budget_notification_channels" {
  description = "Extra Cloud Monitoring notification channel IDs for budget alerts (billing admins are always emailed)."
  type        = list(string)
  default     = []
}

# ---------------------------------------------------------------------------
# Keyless deploy (WIF) scope — which GitHub workflow runs may impersonate
# gha-deployer. The repo is public: a repository-only condition lets ANY
# workflow on ANY branch (or PR ref) of it mint a deploy token.
# ---------------------------------------------------------------------------
variable "wif_allowed_refs" {
  description = "Git refs whose workflow runs may deploy this environment (staging: refs/heads/integration, prod: refs/heads/main)."
  type        = list(string)

  validation {
    condition     = length(var.wif_allowed_refs) > 0 && alltrue([for r in var.wif_allowed_refs : can(regex("^refs/heads/[A-Za-z0-9._/-]+$", r))])
    error_message = "wif_allowed_refs must be one or more refs/heads/<branch> refs (no wildcards)."
  }
}

variable "wif_github_environment" {
  description = "GitHub Environment the deploy jobs run in (its protection rules gate the token). staging | production."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9_-]+$", var.wif_github_environment))
    error_message = "wif_github_environment must be a plain GitHub Environment name."
  }
}

# ---------------------------------------------------------------------------
# In-VPC proof VM (bastion.tf)
# ---------------------------------------------------------------------------
variable "enable_bastion" {
  description = "Create the small in-VPC proof VM (IAP SSH only). For proving an environment from inside its VPC; turn off when done."
  type        = bool
  default     = false
}

variable "bastion_machine_type" {
  description = "Machine type for the proof VM. e2-small (2 vCPU burst, 2 GB) fits npm ci + the integration suite."
  type        = string
  default     = "e2-small"
}

variable "noncurrent_version_retention_days" {
  description = "Days a noncurrent (deleted or overwritten) object version is kept before the bucket lifecycle deletes it. The app already deletes every generation on note/account deletion; this is the backstop. Must stay well inside docs/DATA-RETENTION.md's 30-day deletion window."
  type        = number
  default     = 7
  validation {
    condition     = var.noncurrent_version_retention_days >= 1 && var.noncurrent_version_retention_days <= 30
    error_message = "noncurrent_version_retention_days must be 1-30 (the deletion window is 30 days)."
  }
}

variable "enable_sweeper" {
  description = "Create the db-sweep Cloud Run Job and the Cloud Scheduler job that runs it (scheduler.tf)."
  type        = bool
  default     = true
}

variable "sweep_schedule" {
  description = "Cron schedule (UTC) for the db-sweep job."
  type        = string
  default     = "*/15 * * * *"
}
