#!/usr/bin/env bash
# The PR train's last step (RELEASE.md rev 11, R11.5): a merge is done when staging runs it. Given a merged PR
# (or a commit on integration), this follows the commit to its deploy-staging run and checks:
#   1. the run concluded success (a deploy that didn't need to run, e.g. docs only, is reported and passes);
#   2. every service the run built serves an image tagged with that commit (Cloud Run's live revision);
#   3. the smoke job passed.
# It exits non-zero on any red, which stops the train: the next PR waits until this one runs on staging.
#
# Usage: scripts/train.sh <pr-number | sha>
# Env: PROJECT (default algominutes-staging), REGION (default australia-southeast1), GCLOUD_ACCOUNT (optional,
#      passed to gcloud as --account), WAIT_MINUTES (default 90).
# Requires: gh (authenticated), gcloud (read access to Cloud Run), jq.
set -euo pipefail

target="${1:?usage: scripts/train.sh <pr-number | sha>}"
PROJECT="${PROJECT:-algominutes-staging}"
REGION="${REGION:-australia-southeast1}"
WAIT_MINUTES="${WAIT_MINUTES:-90}"
account=()
[ -n "${GCLOUD_ACCOUNT:-}" ] && account=(--account "$GCLOUD_ACCOUNT")

red() { echo "train: RED: $*" >&2; exit 1; }

# The commit: a PR's merge commit, or the sha given.
if [[ "$target" =~ ^[0-9]+$ ]]; then
  pr=$(gh pr view "$target" --json state,mergeCommit)
  [ "$(jq -r .state <<<"$pr")" = "MERGED" ] || red "PR $target is not merged ($(jq -r .state <<<"$pr"))"
  sha=$(jq -r .mergeCommit.oid <<<"$pr")
else
  sha=$(git rev-parse "$target")
fi
echo "train: following ${sha:0:7}"

# Its deploy-staging run. A push that touches no deployable path starts none.
run=""
for _ in $(seq 1 12); do
  run=$(gh run list --workflow deploy-staging.yml --commit "$sha" --limit 1 --json databaseId -q '.[0].databaseId // empty')
  [ -n "$run" ] && break
  sleep 10
done
if [ -z "$run" ]; then
  echo "train: no deploy-staging run for ${sha:0:7} (nothing deployable changed): done"
  exit 0
fi
echo "train: deploy-staging run $run"

deadline=$(( $(date +%s) + WAIT_MINUTES * 60 ))
while :; do
  status=$(gh run view "$run" --json status -q .status)
  [ "$status" = "completed" ] && break
  [ "$(date +%s)" -lt "$deadline" ] || red "run $run still $status after $WAIT_MINUTES minutes"
  sleep 30
done

jobs=$(gh run view "$run" --json conclusion,jobs)
conclusion=$(jq -r .conclusion <<<"$jobs")
if [ "$conclusion" != "success" ]; then
  jq -r '.jobs[] | select(.conclusion == "failure") | "  failed: \(.name)"' <<<"$jobs" >&2
  red "run $run concluded $conclusion"
fi

# Every image the run built must be what the service SERVES: its latest ready revision, not the spec's image,
# which names a failed rollout's image too. A revision records its image by digest. The deploy pushed the
# commit's tag as an image index (buildx), and Cloud Run runs the index's linux/amd64 manifest, so the live
# digest must be the index or one of its manifests. db-job is a Cloud Run job, and the migrate step checked it.
token=$(gcloud auth print-access-token "${account[@]}")
registry="https://${REGION}-docker.pkg.dev/v2/${PROJECT}/algominutes"
fail=0
# Only images this run built: a run with nothing to deploy skips the matrix, whose job keeps its unexpanded name.
built=$(jq -r '.jobs[] | select((.name | startswith("image (")) and .conclusion == "success") | .name | capture("image \\((?<s>[^)]+)\\)").s' <<<"$jobs")
if [ -z "$built" ]; then
  echo "train: run $run built no image (nothing deployable changed): done"
  exit 0
fi
for svc in $built; do
  [ "$svc" = "db-job" ] && continue
  read -r ready created < <(gcloud run services describe "$svc" --region "$REGION" --project "$PROJECT" "${account[@]}" \
    --format='value(status.latestReadyRevisionName,status.latestCreatedRevisionName)')
  live=$(gcloud run revisions describe "$ready" --region "$REGION" --project "$PROJECT" "${account[@]}" \
    --format='value(spec.containers[0].image)')
  live="${live##*@}"
  headers=$(mktemp)
  index=$(curl -sf -D "$headers" -H "Authorization: Bearer $token" \
    -H 'Accept: application/vnd.oci.image.index.v1+json, application/vnd.docker.distribution.manifest.list.v2+json, application/vnd.oci.image.manifest.v1+json, application/vnd.docker.distribution.manifest.v2+json' \
    "$registry/$svc/manifests/$sha") || red "no $svc image tagged ${sha:0:7} in Artifact Registry"
  own=$(tr -d '\r' <"$headers" | awk -F': ' 'tolower($1) == "docker-content-digest" {print $2}')
  rm -f "$headers"
  if [ "$ready" != "$created" ]; then
    echo "train: $svc's newest revision $created never became ready; it still serves $ready" >&2
    fail=1
  elif [ "$live" = "$own" ] || jq -e --arg d "$live" '[.manifests[]?.digest] | index($d)' <<<"$index" >/dev/null; then
    echo "train: $svc live at ${sha:0:7} ($ready)"
  else
    echo "train: $svc serves ${live:7:12} ($ready), not ${sha:0:7}; if a later merge has deployed since, follow that one" >&2
    fail=1
  fi
done
[ "$fail" -eq 0 ] || red "a service isn't serving ${sha:0:7}"

[ "$(jq -r '.jobs[] | select(.name == "smoke") | .conclusion' <<<"$jobs")" = "success" ] || red "smoke didn't pass"
echo "train: GREEN: ${sha:0:7} runs on staging"
