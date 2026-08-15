# PRODUCTION — confirmed project identifiers (docs/INFRASTRUCTURE.md §4.3)
project_id     = "algominutes-prod"
project_number = "758033737651"
region         = "australia-southeast1"

# Cloud SQL edition — pinned ENTERPRISE (db-custom-1-3840 is valid on both;
# ENTERPRISE avoids the pricier ENTERPRISE_PLUS default). See docs/DECISIONS.md (A4).
db_edition = "ENTERPRISE"
