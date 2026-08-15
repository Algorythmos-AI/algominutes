# ---------------------------------------------------------------------------
# environment module — outputs
# ---------------------------------------------------------------------------

output "sql_instance_connection_name" {
  description = "Cloud SQL connection name (project:region:instance) for the Cloud SQL connector / socket."
  value       = google_sql_database_instance.pg.connection_name
}

output "sql_instance_name" {
  description = "Cloud SQL instance name."
  value       = google_sql_database_instance.pg.name
}

output "sql_private_ip" {
  description = "Private IP address of the Cloud SQL instance (reachable only inside the VPC)."
  value       = google_sql_database_instance.pg.private_ip_address
}

output "database_name" {
  description = "Application database name."
  value       = google_sql_database.app.name
}

output "db_user" {
  description = "Application database user."
  value       = google_sql_user.app.name
}

output "db_password_secret_id" {
  description = "Secret Manager secret ID holding the DB password."
  value       = google_secret_manager_secret.db_password.secret_id
}

output "db_password_secret_name" {
  description = "Fully-qualified Secret Manager secret resource name."
  value       = google_secret_manager_secret.db_password.name
}

output "bucket_names" {
  description = "Map of suffix -> bucket name for recordings/imports/scans."
  value       = { for k, b in google_storage_bucket.buckets : k => b.name }
}

output "queue_ids" {
  description = "Map of queue name -> Cloud Tasks queue resource id."
  value       = { for k, q in google_cloud_tasks_queue.queues : k => q.id }
}

output "service_account_emails" {
  description = "Map of service key (run-*) -> runtime service account email."
  value       = { for k, sa in google_service_account.runtime : k => sa.email }
}

output "vpc_connector_id" {
  description = "Serverless VPC Access connector id — set as Cloud Run egress connector in A11."
  value       = google_vpc_access_connector.connector.id
}

output "vpc_network_id" {
  description = "VPC network id."
  value       = google_compute_network.vpc.id
}

output "artifact_registry_repository" {
  description = "Artifact Registry Docker repository id."
  value       = google_artifact_registry_repository.docker.id
}

output "firestore_database" {
  description = "Firestore database name."
  value       = google_firestore_database.db.name
}
