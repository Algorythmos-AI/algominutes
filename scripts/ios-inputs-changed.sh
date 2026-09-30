#!/usr/bin/env bash
# Whether a macOS job has to run for this event: ios.yml's `ios-test` and codeql-swift.yml's `analyze (swift)`
# (their `changes` jobs call this). macOS runners are slow and bill ~10x, so a job runs only when its inputs
# changed; a skipped job still satisfies a required check.
#
#   scripts/ios-inputs-changed.sh "<check name>" <path>...
#
# Writes ios=true|false to $GITHUB_OUTPUT. Reads EVENT, PR_BASE, QUEUE_BASE, QUEUE_HEAD_REF, BEFORE, REPO,
# GH_TOKEN and SKIP_PUSH_IF_PR_PASSED from the environment.
#
# - pull_request, push: runs when any of the paths changed since the base.
# - merge_group: the same, and then it skips anyway when the queue's commit has exactly the inputs of the PR
#   head that already passed this check. The queue's commit is integration plus the PR; if its inputs are
#   byte-for-byte the head's, the check can only answer as it did on the head, so running it again was 20-40
#   minutes of the merge queue per iOS PR for nothing. Anything else ahead of it in the queue that touched
#   the paths makes them differ, and it runs.
# - push, with SKIP_PUSH_IF_PR_PASSED=true (the iOS tests): the same rule for the merged PR's commit. Its inputs
#   are the PR head's when nothing else touched them, and re-testing them only held a macOS runner (the org gets
#   about three) while the next PR waited for one. The Swift scan doesn't set it: its push run is what keeps the
#   default branch's code-scanning alerts current.
# Any doubt (no usable base, a lookup failing) runs the job.
set -euo pipefail

check=$1
shift
paths=("$@")

decide() {
  echo "ios=$1" >> "$GITHUB_OUTPUT"
  echo "$2"
  exit 0
}

case "${EVENT:-}" in
  pull_request) base=${PR_BASE:-} ;;
  merge_group) base=${QUEUE_BASE:-} ;;
  push) base=${BEFORE:-} ;;
  *) decide true "a scheduled or manual run: always" ;;
esac

# A new branch or a force-push has no usable "before": run.
if [ -z "$base" ] || [ "$base" = "0000000000000000000000000000000000000000" ] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  decide true "no usable base: running"
fi

changed=$(git diff --name-only "$base" "$GITHUB_SHA" -- "${paths[@]}")
if [ -z "$changed" ]; then
  decide false "none of ${paths[*]} changed: skipped"
fi

# Skips (and exits) when this commit's inputs are exactly PR $1's head's and that head passed the check.
skip_if_pr_head_passed() {
  local pr=$1 what=$2 head name passed
  if [ -z "$pr" ] || ! git fetch -q --depth=1 origin "refs/pull/$pr/head" 2>/dev/null; then
    echo "couldn't find $what's PR head (${pr:-no PR}): running"
    return
  fi
  head=$(git rev-parse FETCH_HEAD)
  if [ -n "$(git diff --name-only "$head" "$GITHUB_SHA" -- "${paths[@]}")" ]; then
    echo "$what's inputs differ from PR #$pr's head (something else changed them): running"
    return
  fi
  name=$(jq -rn --arg c "$check" '$c | @uri')
  passed=$(gh api "repos/$REPO/commits/$head/check-runs?check_name=$name" \
    --jq '[.check_runs[] | select(.conclusion == "success")] | length' 2>/dev/null || echo 0)
  if [ "${passed:-0}" -gt 0 ]; then
    decide false "$what's ${paths[*]} are exactly PR #$pr's head ($head), which passed '$check': skipped"
  fi
  echo "PR #$pr's head has the same inputs but hasn't passed '$check' (found $passed): running"
}

if [ "$EVENT" = "merge_group" ]; then
  # refs/heads/gh-readonly-queue/<base branch>/pr-<number>-<base sha>
  skip_if_pr_head_passed "$(printf '%s' "${QUEUE_HEAD_REF:-}" | sed -n 's#^.*/pr-\([0-9][0-9]*\)-[0-9a-f]*$#\1#p')" "the queue's commit"
fi
if [ "$EVENT" = "push" ] && [ "${SKIP_PUSH_IF_PR_PASSED:-}" = "true" ]; then
  # The PR this pushed commit came from (a squash merge of the queue's commit).
  skip_if_pr_head_passed "$(gh api "repos/$REPO/commits/$GITHUB_SHA/pulls" --jq '.[0].number // empty' 2>/dev/null || true)" "the pushed commit"
fi

decide true "changed: $(printf '%s\n' "$changed" | head -5 | tr '\n' ' ')"
