# STAGING — confirmed project identifiers (docs/INFRASTRUCTURE.md §4.3)
project_id     = "algominutes-staging"
project_number = "627101926311"
region         = "australia-southeast1"

# Cloud SQL edition — ENTERPRISE allows the shared-core db-f1-micro tier;
# ENTERPRISE_PLUS (Google's new default) rejects it. See docs/DECISIONS.md (A4).
db_edition = "ENTERPRISE"
