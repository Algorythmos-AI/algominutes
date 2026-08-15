# ===========================================================================
# Remote state — GCS backend (STAGING)
#
# ⚠️ BOOTSTRAP: the state bucket must be created ONCE, by hand, BEFORE the
# first `terraform init`. Terraform cannot create the bucket that holds its
# own state. One-time bootstrap (run as gcp-admin@algorythmos.com):
#
#   gcloud storage buckets create gs://algominutes-staging-tfstate \
#     --project=algominutes-staging \
#     --location=australia-southeast1 \
#     --uniform-bucket-level-access \
#     --public-access-prevention
#   gcloud storage buckets update gs://algominutes-staging-tfstate --versioning
#
# ⚠️ STATE CONTAINS THE DB PASSWORD (and the random_password) in plaintext.
# It MUST live in this GCS bucket and MUST NEVER be committed to git. GCS
# encrypts at rest; keep the bucket private + versioned. See .gitignore.
# ===========================================================================

terraform {
  backend "gcs" {
    bucket = "algominutes-staging-tfstate"
    prefix = "terraform/state"
  }
}
