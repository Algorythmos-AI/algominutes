#!/usr/bin/env bash
# GitHub repository settings as reviewed code (plan PR-09). Idempotent.
#
#   bash scripts/github-settings.sh           # dry run: print every request
#   bash scripts/github-settings.sh --apply   # apply (needs repo admin via gh)
#
# What it sets, and why:
#   - Merge methods: squash for feature PRs into integration, a merge commit
#     for integration → main promotions (squashing promotions makes the two
#     branches diverge; plan rev 7 #3). No rebase merges; head branches are
#     deleted on merge.
#   - Environments:
#       staging    — only the `integration` branch may deploy.
#       production — only `main`, and a human (the owner) approves each run.
#     The WIF provider ALSO requires the matching ref + environment claim
#     (infra/terraform/modules/environment/cloud-run.tf), so a deploy token
#     needs both GitHub's gate and Google's.
#   - Branch protection on integration and main: PR-only (no direct pushes),
#     no force-push or deletion, conversations resolved, and every check
#     required. Every workflow runs on every PR, so each check reports: ios and
#     codeql-swift skip their macOS job (a skipped job satisfies a required
#     check) when the iOS app didn't change. Strict: a PR must be up to date
#     with its base, so two PRs that pass apart can't merge into a broken
#     pair. main also requires promotion-guard's `guard`. No approving review
#     is required (a solo owner cannot approve their own PR); admins are
#     included, so nobody bypasses the checks by accident.
#   - Dependabot security updates on (alerts are already on).
set -euo pipefail

REPO="${REPO:-Algorythmos-AI/algominutes}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1

# Exactly the check names the workflows report (verify with `gh pr checks <n>`).
REQUIRED_CHECKS=(
  "test" "integration" "web-build" "firestore-rules"       # ci
  "ios-test"                                               # ios (skipped unless iOS changed)
  "analyze (swift)"                                        # codeql-swift (likewise)
  "check"                                                  # invariants
  "gitleaks"                                               # gitleaks
  "validate (staging)" "validate (prod)"                   # terraform
  "dependency-review"                                      # dependency-review
  "analyze (javascript-typescript)" "analyze (actions)"    # codeql
  "build (api)" "build (billing)" "build (transcoder)" "build (summarizer)"
  "build (embedder)" "build (extractor)" "build (notifier)" "build (db-job)"
)

call() { # method path [json]
  local method="$1" path="$2" body="${3:-}"
  if [ "$APPLY" -eq 0 ]; then
    echo "DRY  $method $path"
    [ -n "$body" ] && printf '%s\n' "$body" | jq . | sed 's/^/       /'
    return 0
  fi
  if [ -n "$body" ]; then
    printf '%s' "$body" | gh api -X "$method" "$path" --input - >/dev/null
  else
    gh api -X "$method" "$path" >/dev/null
  fi
  echo "ok   $method $path"
}

protection() { # branch extra-check...
  local branch="$1"
  shift
  local checks
  checks=$(printf '%s\n' "${REQUIRED_CHECKS[@]}" "$@" | jq -R '{context: .}' | jq -s .)
  jq -n --argjson checks "$checks" '{
    required_status_checks: { strict: true, checks: $checks },
    enforce_admins: true,
    required_pull_request_reviews: { required_approving_review_count: 0, dismiss_stale_reviews: false },
    restrictions: null,
    required_linear_history: false,
    allow_force_pushes: false,
    allow_deletions: false,
    required_conversation_resolution: true
  }' | { read -r -d '' body || true; call PUT "repos/$REPO/branches/$branch/protection" "$body"; }
}

environment() { # name branch [reviewer-id]
  local name="$1" branch="$2" reviewer="${3:-}"
  local body
  body=$(jq -n --arg r "$reviewer" '{
      deployment_branch_policy: { protected_branches: false, custom_branch_policies: true }
    } + (if $r == "" then {} else { reviewers: [{ type: "User", id: ($r | tonumber) }], prevent_self_review: false } end)')
  call PUT "repos/$REPO/environments/$name" "$body"
  # Replace the branch policy list with exactly this branch.
  if [ "$APPLY" -eq 1 ]; then
    gh api "repos/$REPO/environments/$name/deployment-branch-policies" --jq '.branch_policies[].id' |
      while read -r id; do gh api -X DELETE "repos/$REPO/environments/$name/deployment-branch-policies/$id" >/dev/null; done
  fi
  call POST "repos/$REPO/environments/$name/deployment-branch-policies" "$(jq -n --arg b "$branch" '{name: $b, type: "branch"}')"
}

echo "== $REPO ($([ "$APPLY" -eq 1 ] && echo APPLY || echo 'dry run; pass --apply to change settings'))"

call PATCH "repos/$REPO" "$(jq -n '{
  allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: false,
  delete_branch_on_merge: true
}')"

owner_id=$(gh api user --jq .id)
environment staging integration
environment production main "$owner_id"

protection integration
protection main "guard"

call PUT "repos/$REPO/automated-security-fixes"

echo "== done"
