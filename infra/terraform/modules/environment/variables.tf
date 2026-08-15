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
