# services/db-job — Cloud Run Job for programmatic DB ops

Tier 4 in `docs/runbooks/cloud-sql-access.md` — runs inside the
project VPC with native private-IP access to ${GCP_PROJECT}-pg.
Use this instead of laptop-tethered scripts for any long-running or
programmatic DB work (corpus backfill, batch eval, scheduled audits).

## Why this beats laptop-side scripts

- Native private-IP — no SSH tunnel, no `cloud-sql-proxy`, no orphan
  proxy class of bugs we hit during Phase 0 verification.
- Long-running jobs survive laptop disconnects, Wi-Fi drops, sleep.
- Stdout auto-captured by Cloud Logging — audit trail for free.
- Reuses already-working VPC connector (`sql-connector`) + secret
  bindings (`CLOUD_SQL_PASSWORD`).

## Handlers

Dispatched by `JOB_NAME` env var:

| JOB_NAME           | Handler                                | Status |
|--------------------|----------------------------------------|--------|
| `verify-phase-0`   | `src/handlers/verify-phase-0.js`       | ready  |
| `backfill-pr-d`    | `src/handlers/backfill-pr-d.js`        | scaffold (Phase β.3 will implement) |

Add a new handler by:
1. Writing `src/handlers/<name>.js` exporting `{ run({ log, traceId, env }) }`.
2. Registering the name in `HANDLERS` in `src/index.js`.

## Build + deploy

`shared/` must be copied into the build context (mirrors `services/deploy.sh`
pattern):

```bash
cp -R shared services/db-job/shared
trap 'rm -rf services/db-job/shared' EXIT
gcloud builds submit services/db-job \
  --tag us-central1-docker.pkg.dev/${GCP_PROJECT}/cloud-run-source-deploy/db-job:TAG \
  --project ${GCP_PROJECT}
```

First-time create:

```bash
gcloud run jobs create db-job \
  --image us-central1-docker.pkg.dev/${GCP_PROJECT}/cloud-run-source-deploy/db-job:TAG \
  --region us-central1 --project ${GCP_PROJECT} \
  --vpc-connector sql-connector \
  --vpc-egress private-ranges-only \
  --service-account algominutes-jobs-sa@${GCP_PROJECT}.iam.gserviceaccount.com \
  --set-env-vars PGHOST=10.47.0.5,PGUSER=postgres,PGDATABASE=postgres,JOB_NAME=verify-phase-0 \
  --set-secrets PGPASSWORD=CLOUD_SQL_PASSWORD:latest \
  --max-retries 0 --task-timeout 3600
```

Subsequent updates (image only, preserves env + secrets):

```bash
gcloud run jobs update db-job --region us-central1 --project ${GCP_PROJECT} \
  --image us-central1-docker.pkg.dev/${GCP_PROJECT}/cloud-run-source-deploy/db-job:NEW_TAG
```

## Invoke

```bash
# verify-phase-0 (read-only)
gcloud run jobs execute db-job --region us-central1 --project ${GCP_PROJECT} \
  --update-env-vars JOB_NAME=verify-phase-0 --wait

# backfill-pr-d (DESTRUCTIVE — see Phase β.3 in plan v3.1 for full pre-flight)
gcloud run jobs execute db-job --region us-central1 --project ${GCP_PROJECT} \
  --update-env-vars JOB_NAME=backfill-pr-d,MODE=dry-run --wait
# review dry-run output, get user authorization, then:
gcloud run jobs execute db-job --region us-central1 --project ${GCP_PROJECT} \
  --update-env-vars JOB_NAME=backfill-pr-d,MODE=commit --wait
```

Read structured logs:

```bash
gcloud logging read \
  'resource.type=cloud_run_job AND resource.labels.job_name=db-job' \
  --project ${GCP_PROJECT} --limit 200 --freshness=15m \
  --format=json | jq '.[].jsonPayload | {level, msg, query, pass, row, mode}'
```

## CLAUDE.md compliance

- **§2 PII**: any handler reading `transcript_lines.text` and sending to
  Gemini/embedder must wrap with `redactPII` from `shared/redaction.cjs`.
  Reads-and-checks (like `verify-phase-0`) are exempt — they only count
  PII shapes, never forward text.
- **§2 logging**: structured JSON via `shared/logger.cjs` (with fallback
  in `src/index.js`). Every log line carries `traceId`, `service=db-job`,
  `jobName`. No `console.*`.
- **§2 idempotency**: handlers writing rows (Phase β.3 backfill) must use
  `ON CONFLICT … DO UPDATE` and resume from a progress table.
- **§2 multi-tenancy**: any handler reading user data filters by
  `workspace_members` or per-workspace iteration.

## Related

- `docs/runbooks/cloud-sql-access.md` — when to pick this vs Studio vs bastion
- `docs/runbooks/bastion-psql.md` — Tier 3 fallback for ad-hoc dev
- `evidence/phase-0-queries-studio.sql` — same queries as `verify-phase-0` handler
