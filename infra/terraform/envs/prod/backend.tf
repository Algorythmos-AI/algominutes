# ===========================================================================
# Remote state — GCS backend (PRODUCTION)
#
# ⚠️ BOOTSTRAP: the state bucket must be created ONCE, by hand, BEFORE the
# first `terraform init`. Terraform cannot create the bucket that holds its
# own state. One-time bootstrap (run as an Owner, e.g. algorythmos.france@gmail.com):
#
#   gcloud storage buckets create gs://algominutes-production-tfstate \
#     --project=algominutes-production \
#     --location=australia-southeast1 \
#     --uniform-bucket-level-access \
#     --public-access-prevention
#   gcloud storage buckets update gs://algominutes-production-tfstate --versioning
#
# ⚠️ STATE CONTAINS THE DB PASSWORD (and the random_password) in plaintext.
# It MUST live in this GCS bucket and MUST NEVER be committed to git. GCS
# encrypts at rest; keep the bucket private + versioned. See .gitignore.
# ===========================================================================

terraform {
  backend "gcs" {
    bucket = "algominutes-production-tfstate"
    prefix = "terraform/state"
  }
}
