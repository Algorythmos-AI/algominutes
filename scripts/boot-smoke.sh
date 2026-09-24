#!/usr/bin/env bash
# Boot smoke for one service image: start it with syntactically valid but fake
# config and require that it (a) gets past module loading and env validation and
# (b) answers its health endpoint with 200. db-job is a one-shot Job, so it must
# instead exit with its documented "unknown job" code after loading.
# Nothing here reaches a real database or Google API: DB pools and clients are
# lazy, so a correct image boots without them.
# Usage: scripts/boot-smoke.sh <service> <image>
set -euo pipefail
svc="$1"
image="$2"
name="boot-smoke-$svc"

env_args=(
  -e NODE_ENV=production -e PORT=8080 -e WRITE_POSTGRES=true
  -e GOOGLE_CLOUD_PROJECT=boot-smoke -e GCLOUD_PROJECT=boot-smoke
  -e PGHOST=127.0.0.1 -e PGPORT=5432 -e PGDATABASE=boot -e PGUSER=boot -e PGPASSWORD=boot
  -e TASKS_PROJECT=boot-smoke -e TASKS_LOCATION=australia-southeast1
  -e TRANSCODE_QUEUE=transcode -e SUMMARIZE_QUEUE=summarize -e EMBED_QUEUE=embed
  -e NOTIFY_QUEUE=notify -e EXTRACT_QUEUE=extract
  -e JOBS_SA_EMAIL=run-jobs@boot-smoke.iam.gserviceaccount.com
  -e TRANSCODER_URL=https://transcoder.invalid -e SUMMARIZER_URL=https://summarizer.invalid
  -e EMBEDDER_URL=https://embedder.invalid -e NOTIFIER_URL=https://notifier.invalid
  -e EXTRACTOR_URL=https://extractor.invalid
  -e STORAGE_BUCKET=boot-smoke-recordings -e GCS_BUCKET=boot-smoke-bucket
  -e ALLOWED_ORIGINS=https://boot-smoke.invalid
)

case "$svc" in
  api) path=/v1/health ;;
  extractor) path=/health ;;
  billing) path=/health ;;
  db-job) path= ;;
  *) path=/healthz ;;
esac

if [ "$svc" = "db-job" ]; then
  set +e
  out=$(docker run --rm "${env_args[@]}" -e JOB_NAME=__boot_smoke__ "$image" 2>&1)
  code=$?
  set -e
  echo "$out" | tail -20
  if ! { [ "$code" -eq 64 ] && echo "$out" | grep -q job_name_unknown; }; then
    echo "boot-smoke $svc: FAILED (exit $code)"
    exit 1
  fi
  # The deploy runs JOB_NAME=migrate before every rollout. Prove, without a
  # database, that the image resolves the migrator and ships its migrations:
  # a deliberately wrong expected head must fail on the head check, naming
  # the newest migration baked into the image.
  set +e
  out=$(docker run --rm "${env_args[@]}" -e JOB_NAME=migrate -e EXPECTED_MIGRATION_HEAD=__boot_smoke__ "$image" 2>&1)
  code=$?
  set -e
  echo "$out" | tail -5
  if [ "$code" -eq 1 ] && echo "$out" | grep -qE 'head mismatch: this image ships [0-9]{3}_'; then
    echo "boot-smoke $svc: ok (unknown job -> 64; migrate handler loads and sees its migrations)"
    exit 0
  fi
  echo "boot-smoke $svc: FAILED migrate probe (exit $code)"
  exit 1
fi

docker run -d --name "$name" -p 18080:8080 "${env_args[@]}" "$image" >/dev/null
trap 'docker rm -f "$name" >/dev/null 2>&1 || true' EXIT

for _ in $(seq 1 30); do
  if [ "$(docker inspect -f '{{.State.Running}}' "$name")" != "true" ]; then
    echo "boot-smoke $svc: container exited during startup"
    docker logs "$name" 2>&1 | tail -40
    exit 1
  fi
  code=$(curl -s -o /dev/null -w '%{http_code}' "http://127.0.0.1:18080$path" || true)
  if [ "$code" = "200" ]; then
    echo "boot-smoke $svc: ok ($path -> 200)"
    exit 0
  fi
  sleep 2
done

echo "boot-smoke $svc: no 200 from $path within 60s"
docker logs "$name" 2>&1 | tail -40
exit 1
