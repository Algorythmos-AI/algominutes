#!/usr/bin/env bash
# Post-deploy smoke for staging Cloud Run. Verifies, against the LIVE services,
# the assumptions Terraform could not prove at plan time:
#   1. every *_URL env the services were given resolves to a URL the target
#      service actually serves (deterministic hostnames — cloud-run.tf header);
#   2. api and billing are publicly reachable (app / webhook callers);
#   3. every worker rejects an unauthenticated caller (IAM-private).
# Requires: gcloud (authenticated), jq, curl. Env: PROJECT, REGION.
set -euo pipefail

: "${PROJECT:?PROJECT is required}"
REGION="${REGION:-australia-southeast1}"
PUBLIC=(api billing)
PRIVATE=(transcoder summarizer embedder extractor notifier)
fail=0

describe() { gcloud run services describe "$1" --region "$REGION" --project "$PROJECT" --format=json; }

# All URLs a service answers on: status.url plus the run.googleapis.com/urls
# annotation (which lists the deterministic SERVICE-PROJECTNUMBER hostname).
urls_of() {
  describe "$1" | jq -r '
    [.status.url]
    + ((.metadata.annotations["run.googleapis.com/urls"] // "[]") | fromjson)
    | unique | .[]'
}

check_code() { # name url expected
  local code
  code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 30 "$2" || echo 000)
  if [ "$code" = "$3" ]; then
    echo "ok   $1 $2 -> $code"
  else
    echo "FAIL $1 $2 -> $code (expected $3)"
    fail=1
  fi
}

echo "== 1. downstream URL envs match live service URLs =="
api_env=$(describe api | jq -r '.spec.template.spec.containers[0].env // [] | .[] | select(.value != null) | "\(.name)=\(.value)"')
for pair in TRANSCODER_URL:transcoder SUMMARIZER_URL:summarizer EMBEDDER_URL:embedder EXTRACTOR_URL:extractor NOTIFIER_URL:notifier; do
  var=${pair%%:*}
  svc=${pair##*:}
  configured=$(printf '%s\n' "$api_env" | sed -n "s/^${var}=//p")
  if [ -z "$configured" ]; then
    echo "FAIL $var not set on api"
    fail=1
    continue
  fi
  if urls_of "$svc" | grep -qxF "$configured"; then
    echo "ok   $var=$configured"
  else
    echo "FAIL $var=$configured is not a URL of $svc (serves: $(urls_of "$svc" | tr '\n' ' '))"
    fail=1
  fi
done

echo "== 2. public services reachable without auth =="
api_url=$(describe api | jq -r .status.url)
billing_url=$(describe billing | jq -r .status.url)
check_code api "$api_url/v1/health" 200
# /health, not /healthz: Cloud Run's front end reserves paths ending in "z".
check_code billing "$billing_url/health" 200

echo "== 3. workers reject unauthenticated callers =="
for svc in "${PRIVATE[@]}"; do
  check_code "$svc" "$(describe "$svc" | jq -r .status.url)/" 403
done

if [ "$fail" -ne 0 ]; then
  echo "smoke: FAILED"
  exit 1
fi
echo "smoke: all checks passed (${#PUBLIC[@]} public, ${#PRIVATE[@]} private)"
