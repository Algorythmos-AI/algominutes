# ---------------------------------------------------------------------------
# Optional in-VPC proof VM ("bastion"). Off by default (var.enable_bastion).
#
# Cloud SQL has a private IP only, and Cloud Run jobs are one-shot. This small
# VM is where an operator (via IAP SSH) proves the environment from
# INSIDE the VPC: TLS-only Postgres, schema at head, the integration suite
# against Cloud SQL itself, and the Vertex models in-region. See
# docs/runbooks/staging-proof.md and scripts/prove-staging.sh.
#
# Locked down:
#   - No inbound traffic except SSH from Google's IAP range (35.235.240.0/20),
#     and only to this VM. The custom VPC has no other allow-ingress rules.
#   - OS Login only; project-wide SSH keys are blocked.
#   - An ephemeral external IP for OUTBOUND installs only (apt, Node, npm).
#     Cloud NAT stays off (var.enable_nat).
#   - Its own service account, able to read the DB password secret and call
#     Vertex, and nothing else.
#   - Shielded VM.
# Cost: e2-small plus an ephemeral IP, roughly US$15/month while it exists.
# Set enable_bastion = false and apply to remove it.
# ---------------------------------------------------------------------------

resource "google_service_account" "bastion" {
  count        = var.enable_bastion ? 1 : 0
  project      = var.project_id
  account_id   = "bastion"
  display_name = "AlgoMinutes ${var.env} proof VM (in-VPC checks)"
}

resource "google_project_iam_member" "bastion" {
  for_each = var.enable_bastion ? toset([
    "roles/logging.logWriter",
    "roles/aiplatform.user", # vertex-smoke from inside the VPC
  ]) : toset([])
  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.bastion[0].email}"
}

# Resource-level: this one secret, not every secret in the project.
resource "google_secret_manager_secret_iam_member" "bastion_db_password" {
  count     = var.enable_bastion ? 1 : 0
  project   = var.project_id
  secret_id = google_secret_manager_secret.db_password.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.bastion[0].email}"
}

resource "google_compute_firewall" "bastion_iap_ssh" {
  count     = var.enable_bastion ? 1 : 0
  project   = var.project_id
  name      = "algominutes-${var.env}-allow-iap-ssh-bastion"
  network   = google_compute_network.vpc.id
  direction = "INGRESS"

  allow {
    protocol = "tcp"
    ports    = ["22"]
  }
  source_ranges           = ["35.235.240.0/20"] # Google IAP TCP forwarding
  target_service_accounts = [google_service_account.bastion[0].email]
}

resource "google_compute_instance" "bastion" {
  count        = var.enable_bastion ? 1 : 0
  project      = var.project_id
  name         = "algominutes-${var.env}-bastion"
  machine_type = var.bastion_machine_type
  zone         = "${var.region}-a"
  labels       = { env = var.env, purpose = "in-vpc-proof" }

  boot_disk {
    initialize_params {
      image = "debian-cloud/debian-12"
      size  = 20
    }
  }

  network_interface {
    subnetwork = google_compute_subnetwork.subnet.id
    access_config {} # ephemeral external IP: egress only (see header)
  }

  service_account {
    email  = google_service_account.bastion[0].email
    scopes = ["cloud-platform"] # effective access is the SA's IAM above
  }

  shielded_instance_config {
    enable_secure_boot          = true
    enable_vtpm                 = true
    enable_integrity_monitoring = true
  }

  # Connection facts for scripts/prove-staging.sh, read from the metadata
  # server. No secrets here: the password stays in Secret Manager.
  metadata = {
    enable-oslogin         = "TRUE"
    block-project-ssh-keys = "TRUE"
    db-host                = google_sql_database_instance.pg.private_ip_address
    db-name                = google_sql_database.app.name
    db-user                = google_sql_user.app.name
    db-password-secret     = google_secret_manager_secret.db_password.secret_id
    aiplatform-location    = var.region
  }
  metadata_startup_script = file("${path.module}/bastion-startup.sh")

  allow_stopping_for_update = true
  depends_on                = [google_project_service.apis]
}
