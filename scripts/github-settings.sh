#!/usr/bin/env bash
# GitHub repository settings as reviewed code (plan PR-09). Idempotent.
#
#   bash scripts/github-settings.sh           # dry run: print every request
#   bash scripts/github-settings.sh --apply   # apply (needs repo admin via gh)
#
# What it sets, and why:
#   - Merge methods: squash for feature PRs into integration, a merge commit
#     for integration → main promotions (squashing promotions makes the two
#     branches diverge; plan rev 7 #3). No rebase merges: the box was ticked in
#     the UI on 2026-09-28, and --apply unticks it. Head branches are deleted
#     on merge.
#   - Auto-merge on (`gh pr merge <n> --auto` queues a PR once its checks
#     pass), and "Always suggest updating pull request branches" on.
#   - Environments:
#       staging    — only the `integration` branch may deploy.
#       production — only `main`, and a human (the owner) approves each run.
#     The WIF provider ALSO requires the matching ref + environment claim
#     (infra/terraform/modules/environment/cloud-run.tf), so a deploy token
#     needs both GitHub's gate and Google's.
#   - Both branches: PR-only (no direct pushes), no force-push or deletion,
#     conversations resolved, and every check required. Every workflow runs on
#     every PR and in the merge queue (`merge_group`), so each check reports:
#     ios and codeql-swift skip their macOS job (a skipped job satisfies a
#     required check) when the iOS app didn't change. No approving review is
#     required (a solo owner cannot approve their own PR), and nobody bypasses
#     the rules, admins included.
#   - integration: a repository ruleset, not classic branch protection. The
#     classic REST API has no merge-queue field, so a queue turned on in the
#     classic rule can't be reviewed code, and nothing promises a PUT keeps it.
#     The ruleset holds all of integration's rules, so they have one source.
#     --apply writes it, then deletes the classic rule (and the UI's queue in
#     it); if GitHub refuses the ruleset, the script stops first.
#       Merge queue: squash (the only method the ruleset allows); up to 5
#       entries building at once; 1–5 PRs merged per group, waiting up to 5 min
#       to fill one; every entry must pass its checks (ALLGREEN); a check
#       silent for 90 min fails (the Swift CodeQL job takes about 40).
#       Not strict: the queue tests each PR on the latest integration plus the
#       entries ahead of it, which is what "up to date" was for.
#   - main: classic protection, strict (a PR must be up to date with main), and
#     promotion-guard's `guard` is also required. No queue: promotions are
#     merge commits, one at a time.
#   - Dependabot security updates on (alerts are already on).
#   - The dry run also prints how each branch's live required checks differ
#     from this script's.
set -euo pipefail

REPO="${REPO:-Algorythmos-AI/algominutes}"
APPLY=0
[ "${1:-}" = "--apply" ] && APPLY=1
RULESET=integration # the ruleset's name; --apply finds it by name
ERR=$(mktemp)
trap 'rm -f "$ERR"' EXIT

# Exactly the check names the workflows report (verify with `gh pr checks <n>`).
REQUIRED_CHECKS=(
  "test" "integration" "web-build" "site-build"            # ci
  "firestore-rules"                                        # ci
  "ios-test"                                               # ios (skipped unless iOS changed)
  "analyze (swift)"                                        # codeql-swift (likewise)
  "check"                                                  # invariants
  "gitleaks"                                               # gitleaks
  "validate (staging)" "validate (prod)"                   # terraform
  "dependency-review"                                      # dependency-review (skipped in the queue)
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

get() { # path jq-filter: read live state; a 404 reads as nothing
  if gh api "$1" --jq "$2" 2>"$ERR"; then return 0; fi
  grep -q '(HTTP 404)' "$ERR" && return 0
  cat "$ERR" >&2
  return 1
}

checks_json() { # extra-check...
  printf '%s\n' "${REQUIRED_CHECKS[@]}" "$@" | jq -R '{context: .}' | jq -s .
}

protection() { # branch extra-check...
  local branch="$1"
  shift
  jq -n --argjson checks "$(checks_json "$@")" '{
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

ruleset() { # branch: one ruleset holding all of its rules, the merge queue included
  local branch="$1" body id
  body=$(jq -n --arg name "$RULESET" --arg ref "refs/heads/$branch" --argjson checks "$(checks_json)" '{
    name: $name,
    target: "branch",
    enforcement: "active",
    bypass_actors: [],
    conditions: { ref_name: { include: [$ref], exclude: [] } },
    rules: [
      { type: "deletion" },
      { type: "non_fast_forward" },
      { type: "pull_request", parameters: {
          required_approving_review_count: 0,
          dismiss_stale_reviews_on_push: false,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_review_thread_resolution: true,
          allowed_merge_methods: ["squash"]
      } },
      { type: "required_status_checks", parameters: {
          strict_required_status_checks_policy: false,
          required_status_checks: $checks
      } },
      { type: "merge_queue", parameters: {
          merge_method: "SQUASH",
          max_entries_to_build: 5,
          min_entries_to_merge: 1,
          max_entries_to_merge: 5,
          min_entries_to_merge_wait_minutes: 5,
          grouping_strategy: "ALLGREEN",
          check_response_timeout_minutes: 90
      } }
    ]
  }')
  id=$(get "repos/$REPO/rulesets?per_page=100" \
    ".[] | select(.source_type == \"Repository\" and .name == \"$RULESET\") | .id")
  if [ -n "$id" ]; then
    call PUT "repos/$REPO/rulesets/$id" "$body"
  else
    call POST "repos/$REPO/rulesets" "$body"
  fi
}

unprotect() { # branch: delete its classic protection rule (once gone, nothing to do)
  local path="repos/$REPO/branches/$1/protection"
  if [ "$APPLY" -eq 0 ]; then
    echo "DRY  DELETE $path"
    return 0
  fi
  if gh api -X DELETE "$path" >/dev/null 2>"$ERR"; then
    echo "ok   DELETE $path"
  elif grep -q '(HTTP 404)' "$ERR"; then
    echo "ok   DELETE $path (no classic rule left)"
  else
    cat "$ERR" >&2
    return 1
  fi
}

drift() { # branch expected-check...: the live required checks vs these
  local branch="$1" live changes
  shift
  # Classic protection and rulesets can each require checks: read both.
  if ! live=$({
    get "repos/$REPO/branches/$branch/protection/required_status_checks" '.checks[].context'
    get "repos/$REPO/rules/branches/$branch" \
      '.[] | select(.type == "required_status_checks") | .parameters.required_status_checks[].context'
  } 2>&1 | LC_ALL=C sort -u); then
    echo "     $branch: can't read the live required checks: $live"
    return 0
  fi
  changes=$(LC_ALL=C comm -3 <(grep -v '^$' <<<"$live") <(printf '%s\n' "$@" | LC_ALL=C sort -u) |
    awk -F'\t' '{ print (NF > 1 ? "       + " $2 : "       - " $1) }')
  if [ -z "$changes" ]; then
    echo "     $branch: the live required checks match this script"
  else
    echo "     $branch: --apply changes the required checks (- live only, + script only):"
    printf '%s\n' "$changes"
  fi
}

echo "== $REPO ($([ "$APPLY" -eq 1 ] && echo APPLY || echo 'dry run; pass --apply to change settings'))"

if [ "$APPLY" -eq 0 ]; then
  drift integration "${REQUIRED_CHECKS[@]}"
  drift main "${REQUIRED_CHECKS[@]}" "guard"
fi

call PATCH "repos/$REPO" "$(jq -n '{
  allow_squash_merge: true, allow_merge_commit: true, allow_rebase_merge: false,
  allow_auto_merge: true, allow_update_branch: true,
  delete_branch_on_merge: true
}')"

owner_id=$(gh api user --jq .id)
environment staging integration
environment production main "$owner_id"

ruleset integration # before the classic rule goes, so integration is never unprotected
unprotect integration
protection main "guard"

call PUT "repos/$REPO/automated-security-fixes"

echo "== done"
