# ---------------------------------------------------------------------------
# Firestore security rules (plan PR-11), released from the repo:
# infra/firebase/firestore.rules, tested against the emulator in CI
# (tests/rules/firestore-rules.test.ts).
#
# Without a release, a database created through the API denies every client
# request: the iOS and web apps couldn't list, create or update a note doc.
# A change to the file makes a new ruleset, and the release is replaced to
# point at it.
#
# The Firebase Rules API needs a quota project when Terraform runs on a user's
# credentials (the first staging apply was refused: "requires a quota
# project"), so both resources use the `google.billing` alias
# (user_project_override), as the budget does.
# ---------------------------------------------------------------------------
resource "google_firebaserules_ruleset" "firestore" {
  provider = google.billing
  project  = var.project_id

  source {
    files {
      name    = "firestore.rules"
      content = file("${path.module}/../../../firebase/firestore.rules")
    }
  }

  lifecycle {
    create_before_destroy = true
  }

  depends_on = [google_project_service.apis, google_firestore_database.db]
}

resource "google_firebaserules_release" "firestore" {
  provider     = google.billing
  project      = var.project_id
  name         = "cloud.firestore" # the (default) database
  ruleset_name = "projects/${var.project_id}/rulesets/${google_firebaserules_ruleset.firestore.name}"

  lifecycle {
    replace_triggered_by = [google_firebaserules_ruleset.firestore]
  }
}
