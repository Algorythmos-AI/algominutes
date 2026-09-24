#!/usr/bin/env bash
# prove-staging.sh: prove the environment from INSIDE its VPC. Runs on the
# proof VM (infra/terraform/modules/environment/bastion.tf); see
# docs/runbooks/staging-proof.md.
#
#   gcloud compute ssh algominutes-staging-bastion --zone australia-southeast1-a \
#     --project algominutes-staging --tunnel-through-iap \
#     --command "PROOF_REF=integration bash -s" < scripts/prove-staging.sh
#
# Checks, each printing its evidence:
#   1. tls-enforced     plaintext Postgres is refused by Cloud SQL (ENCRYPTED_ONLY)
#   2. tls-connect      an encrypted session works (pg_stat_ssl)
#   3. extensions       vector / pg_trgm / uuid-ossp installed on Cloud SQL
#   4. schema-at-head   every migration at PROOF_REF is in schema_migrations, with checksums
#   5. integration      the full integration suite, run against Cloud SQL itself
#                       in a throwaway database (the app DB is never touched)
#   6. vertex-smoke     every active Gemini rung + the embedder answer in-region,
#                       with the summarizer's real schema and token budget
# Exit code: 0 only if every check passes.
set -uo pipefail

md() { curl -fsS -H 'Metadata-Flavor: Google' "http://metadata.google.internal/computeMetadata/v1/$1"; }
# PROOF_* overrides exist only to rehearse this script off-VM (e.g. against a
# local Postgres, where the TLS checks are EXPECTED to fail). On the VM,
# everything comes from the metadata server and Secret Manager.
PROJECT=${PROOF_PROJECT:-$(md project/project-id)}
DB_HOST=${PROOF_DB_HOST:-$(md instance/attributes/db-host)}
DB_PORT=${PROOF_DB_PORT:-5432}
DB_NAME=${PROOF_DB_NAME:-$(md instance/attributes/db-name)}
DB_USER=${PROOF_DB_USER:-$(md instance/attributes/db-user)}
AI_LOCATION=${PROOF_AI_LOCATION:-$(md instance/attributes/aiplatform-location)}
REF="${PROOF_REF:-integration}"
WORK="${PROOF_WORKDIR:-$HOME/algominutes-proof}"

if [ -z "${PGPASSWORD:-}" ]; then
  PGPASSWORD=$(gcloud secrets versions access latest --secret "$(md instance/attributes/db-password-secret)" --project "$PROJECT")
fi
export PGPASSWORD PGHOST="$DB_HOST" PGPORT="$DB_PORT" PGUSER="$DB_USER" PGCONNECT_TIMEOUT=10

declare -a RESULTS=()
record() { RESULTS+=("$(printf '%-16s %s  %s' "$1" "$2" "$3")"); echo "[$2] $1: $3"; }
section() { echo; echo "===== $1"; }

echo "prove-staging: project=$PROJECT db=$DB_HOST/$DB_NAME user=$DB_USER ref=$REF vertex=$AI_LOCATION"

section "1. tls-enforced (plaintext must be refused)"
if out=$(PGSSLMODE=disable psql -d "$DB_NAME" -Atc 'select 1' 2>&1); then
  record tls-enforced FAIL "plaintext was ACCEPTED: $(printf '%s\n' "$out" | tr '\n' ' ' | cut -c1-160)"
elif printf '%s\n' "$out" | grep -qiE 'no encryption|SSL|encrypt'; then
  record tls-enforced PASS "plaintext refused: $(printf '%s\n' "$out" | tr '\n' ' ' | cut -c1-160)"
else
  record tls-enforced FAIL "refused, but not for encryption: $(printf '%s\n' "$out" | tr '\n' ' ' | cut -c1-160)"
fi

section "2. tls-connect (encrypted session)"
out=$(PGSSLMODE=require psql -d "$DB_NAME" -Atc \
  "select ssl, version, cipher from pg_stat_ssl where pid = pg_backend_pid()" 2>&1)
if printf '%s\n' "$out" | grep -q '^t|'; then
  record tls-connect PASS "pg_stat_ssl: $out; server $(PGSSLMODE=require psql -d "$DB_NAME" -Atc 'show server_version')"
else
  record tls-connect FAIL "$out"
fi

section "3. extensions"
exts=$(PGSSLMODE=require psql -d "$DB_NAME" -Atc "select string_agg(extname || ' ' || extversion, ', ' order by extname) from pg_extension" 2>&1)
if printf '%s\n' "$exts" | grep -q 'vector' && printf '%s\n' "$exts" | grep -q 'pg_trgm' && printf '%s\n' "$exts" | grep -q 'uuid-ossp'; then
  record extensions PASS "$exts"
else
  record extensions FAIL "$exts"
fi

section "4. schema-at-head (checkout $REF)"
MARKER=".prove-staging-checkout"
if [ "${PROOF_REUSE_CHECKOUT:-0}" = "1" ]; then
  echo "reusing existing checkout at $WORK (rehearsal; no clone, no npm ci)"
else
  # Only ever delete a directory this script created (it leaves a marker), so a
  # mistyped PROOF_WORKDIR can never wipe a real checkout.
  if [ -e "$WORK" ] && [ ! -e "$WORK/$MARKER" ]; then
    echo "refusing to replace $WORK: not a prove-staging checkout (no $MARKER)"; exit 2
  fi
  rm -rf "$WORK" && git clone -q --depth 1 --branch "$REF" https://github.com/Algorythmos-AI/algominutes.git "$WORK" \
    && touch "$WORK/$MARKER"
fi
sha=$(git -C "$WORK" rev-parse --short HEAD)
on_disk=$(find "$WORK/packages/db/migrations" -maxdepth 1 -name '[0-9][0-9][0-9]_*.sql' -exec basename {} \; | sort)
recorded=$(PGSSLMODE=require psql -d "$DB_NAME" -Atc "select filename from schema_migrations order by filename" 2>&1)
missing=$(comm -23 <(printf '%s\n' "$on_disk") <(printf '%s\n' "$recorded"))
no_sum=$(PGSSLMODE=require psql -d "$DB_NAME" -Atc "select count(*) from schema_migrations where checksum is null" 2>&1)
head=$(printf '%s\n' "$on_disk" | tail -1)
if [ -z "$missing" ] && [ "$no_sum" = "0" ]; then
  record schema-at-head PASS "$(printf '%s\n' "$on_disk" | wc -l | tr -d ' ') migrations at $sha, head $head, all recorded with checksums"
else
  record schema-at-head FAIL "missing: [$(printf '%s\n' "$missing" | tr '\n' ' ')] null-checksums: $no_sum"
fi

section "5. integration suite on Cloud SQL (throwaway database)"
throwaways() { PGSSLMODE=require psql -d "$DB_NAME" -Atc "select datname from pg_database where datname like 'proof_%' or datname like 'mig_%' order by 1"; }
before=$(throwaways)
proof_db="proof_$(date +%s)"
if PGSSLMODE=require psql -d "$DB_NAME" -qc "create database $proof_db" 2>&1; then
  if [ "${PROOF_REUSE_CHECKOUT:-0}" != "1" ]; then
    ( cd "$WORK" && npm ci --no-audit --no-fund --loglevel=error >/dev/null 2>&1 ) || echo "npm ci failed"
  fi
  # No password in the URL: pg takes it from PGPASSWORD. TLS is forced.
  it=$(cd "$WORK" && DATABASE_URL="postgres://$DB_USER@$DB_HOST:$DB_PORT/$proof_db" PGSSLMODE="${PROOF_TEST_SSLMODE:-require}" \
       npm run test:integration 2>&1)
  # Judge vitest's own summary lines only (test output contains event names
  # like migration_failed). Pass = "Tests  N passed (N)" and no failed/Errors line.
  summary=$(printf '%s\n' "$it" | grep -E '^\s+(Test Files|Tests|Errors)\s' | tr -s ' ' | tr '\n' ';')
  if printf '%s\n' "$summary" | grep -qE 'Tests [0-9]+ passed \([0-9]+\)' && ! printf '%s\n' "$summary" | grep -qE 'failed|Errors'; then
    record integration PASS "on Cloud SQL, TLS: $summary"
  else
    printf '%s\n' "$it" | tail -40
    record integration FAIL "$summary"
  fi
  PGSSLMODE=require psql -d "$DB_NAME" -qc "drop database if exists $proof_db with (force)" 2>&1 || true
  # Only databases THIS run created and failed to drop count as a leak.
  leaked=$(comm -13 <(printf '%s\n' "$before") <(throwaways) | tr '\n' ' ')
  if [ -n "${leaked// /}" ]; then
    record cleanup FAIL "throwaway databases leaked by this run: $leaked"
  else
    record cleanup PASS "no throwaway databases left by this run"
  fi
else
  record integration FAIL "could not create throwaway database $proof_db"
fi

section "6. vertex-smoke (in-region, real call shape)"
vs=$(cd "$WORK/services/db-job" && JOB_NAME=vertex-smoke WRITE_POSTGRES=true PGDATABASE="$DB_NAME" \
     GOOGLE_CLOUD_PROJECT="$PROJECT" AIPLATFORM_LOCATION="$AI_LOCATION" npx tsx src/index.js 2>&1)
# Node prints non-JSON warnings (e.g. DEP0040) on stderr; keep log lines only.
vs_json=$(printf '%s\n' "$vs" | grep '^{')
oks=$(printf '%s\n' "$vs_json" | jq -rc 'select(.msg=="vertex_smoke_model_ok" or .msg=="vertex_smoke_embedding_ok") | "\(.model) \(.finishReason // ("dims=" + (.dims|tostring))) \(.wallMs // "")ms"' 2>/dev/null | tr '\n' ';')
if printf '%s\n' "$vs" | grep -q '"msg":"job_succeeded"'; then
  record vertex-smoke PASS "$oks"
else
  printf '%s\n' "$vs" | tail -15
  record vertex-smoke FAIL "$(printf '%s\n' "$vs_json" | jq -r 'select(.severity=="ERROR") | (.err.message // .msg) | gsub("\\s+"; " ")' 2>/dev/null | tail -1 | tr '\n' ' ' | cut -c1-220)"
fi

section "RESULT ($PROJECT @ $sha)"
fail=0
for r in "${RESULTS[@]}"; do printf '%s\n' "$r"; printf '%s\n' "$r" | grep -q ' FAIL ' && fail=1; done
[ "$fail" -eq 0 ] && echo "ALL CHECKS PASSED" || echo "SOME CHECKS FAILED"
exit "$fail"
