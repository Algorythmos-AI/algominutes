# ---------------------------------------------------------------------------
# Cloud KMS: the meeting-link key (docs/plans/MEETINGS.md).
#
# A notetaker's meeting link (Zoom's pwd=, a Teams join token) lets anyone who
# has it join the meeting, so it's stored only as ciphertext, only until the bot
# is in the call (@algominutes/ai meeting-url-crypto.cjs). One key, in the
# environment's region, rotated every 90 days (old versions still decrypt).
# The api may only encrypt; the meetings service may only decrypt (its grant is
# added with services/meetings). Key rings and keys can't be deleted, only their
# versions destroyed, so this is created once.
# ---------------------------------------------------------------------------

resource "google_kms_key_ring" "main" {
  project  = var.project_id
  name     = "algominutes-${var.env}"
  location = var.region

  depends_on = [google_project_service.apis]
}

resource "google_kms_crypto_key" "meeting_url" {
  name            = "meeting-url"
  key_ring        = google_kms_key_ring.main.id
  purpose         = "ENCRYPT_DECRYPT"
  rotation_period = "7776000s" # 90 days

  lifecycle {
    prevent_destroy = true
  }
}

resource "google_kms_crypto_key_iam_member" "meeting_url_encrypter_api" {
  crypto_key_id = google_kms_crypto_key.meeting_url.id
  role          = "roles/cloudkms.cryptoKeyEncrypter"
  member        = "serviceAccount:${google_service_account.runtime["run-api"].email}"
}
