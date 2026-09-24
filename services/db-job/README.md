# services/db-job — Cloud Run Job for programmatic DB ops

A one-shot Cloud Run **Job** (not a service) that runs inside the project VPC,
with private-IP access to Cloud SQL. Use it for anything that must touch the
database from inside the network: migrations (every deploy), verification
queries, batch evals. The Cloud SQL instance has no public IP, so a laptop
script would need the Auth Proxy; this doesn't.

## Handlers

Dispatched by the `JOB_NAME` env var (`HANDLERS` in `src/index.js`):

| JOB_NAME            | Handler                           | Notes |
|---------------------|-----------------------------------|-------|
| `migrate`           | `src/handlers/migrate.js`         | **Run by every deploy before rollout.** Requires `EXPECTED_MIGRATION_HEAD`. Runner: `packages/db/src/migrator.ts`. |
| `verify-phase-0`    | `src/handlers/verify-phase-0.js`  | Read-only verification queries. |
| `eval-recall`       | `src/handlers/eval-recall.js`     | Retrieval eval. |
| `eval-diarisation`  | `src/handlers/eval-diarisation.js`| Diarisation eval. |
| `debug-corpus`      | `src/handlers/debug-corpus.js`    | Corpus inspection. |

Add a handler: write `src/handlers/<name>.js` exporting
`{ run({ log, traceId, env }) }` and register it in `HANDLERS`.

## Build + deploy

- **Terraform** creates the job (`infra/terraform/modules/environment/cloud-run.tf`,
  `google_cloud_run_v2_job.db_job`): VPC egress, runtime SA `run-db-job`, DB env
  and the `PGPASSWORD` secret, `PGSSLMODE=require`, `WRITE_POSTGRES=true`.
- **`.github/workflows/deploy-staging.yml`** builds the image at every deploying
  commit, points the job at it and runs `migrate` before any service rolls out.
- Build context is the repo root: `docker build -f services/db-job/Dockerfile .`

## Invoke

```bash
# Migrations (what the deploy runs; idempotent + advisory-locked, safe to re-run):
gcloud run jobs execute db-job --region australia-southeast1 --project "$PROJECT" --wait \
  --update-env-vars "JOB_NAME=migrate,EXPECTED_MIGRATION_HEAD=012_note_speakers.sql,TRACE_ID=$(uuidgen)"

# Read-only verification:
gcloud run jobs execute db-job --region australia-southeast1 --project "$PROJECT" --wait \
  --update-env-vars JOB_NAME=verify-phase-0
```

`EXPECTED_MIGRATION_HEAD` is the newest `NNN_*.sql` in `packages/db/migrations`
at the commit you deployed. `migrate` refuses to run if the image disagrees, and
it fails unless every migration on disk is recorded in `schema_migrations`
afterwards.

Read the structured logs for a run:

```bash
gcloud logging read 'resource.type=cloud_run_job AND jsonPayload.traceId="<TRACE_ID>"' \
  --project "$PROJECT" --freshness=1h --format=json | jq '.[].jsonPayload | {severity, msg, filename, head, err}'
```

## CLAUDE.md compliance

- **Logging:** the shared `@algominutes/ai/logger.cjs`, child-bound with
  `traceId`, `service=db-job` and `jobName` on every line. No `console.*`.
- **PII:** any handler that sends `transcript_lines.text` to Gemini or the embedder
  must wrap it with `redactPII`. Read-and-count handlers (`verify-phase-0`) are
  exempt, because they never forward text.
- **Idempotency:** handlers that write rows use `ON CONFLICT … DO UPDATE`.
  `migrate` is forward-only and records each file once, with its sha256.
- **Multi-tenancy:** any handler that reads user data filters by
  `workspace_members` or iterates per workspace.

## Related

- `docs/runbooks/resume-staging-and-deploy.md` — first deploy + migrations
- `docs/runbooks/cloud-sql-access.md` — when to use this vs Studio vs bastion
- `scripts/check-migrations-applied.mjs` — an operator's independent head check
