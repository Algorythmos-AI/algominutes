# Runbook: a production incident

> Plan rev 12, Stage 4 (`docs/plans/RELEASE.md`): per-service Cloud Run rollback, "prod is down", "a note is
> stuck", who is paged, and the status message. **Production (`algominutes-prod`) is not provisioned yet
> (Apply P, Stage 2).** Every prod command below has been run only against staging's equivalent, or not at
> all. Re-check each one on staging during the Stage 4 chaos drill before relying on it.

You act as **`algorythmos.france@gmail.com`** (Owner on the project), as in
`docs/runbooks/resume-staging-and-deploy.md` §0. Set these once per shell:

```bash
gcloud auth login algorythmos.france@gmail.com --no-activate   # once per machine
export PROJECT=algominutes-prod REGION=australia-southeast1 ACCOUNT=algorythmos.france@gmail.com
export AR="$REGION-docker.pkg.dev/$PROJECT/algominutes"        # images: $AR/<service>:<full commit sha>
```

For staging, use `PROJECT=algominutes-staging`; everything else is the same.

## 1. Who is paged

Nobody. There is no paging and no on-call rota (RELEASE.md O4).

- **Alerts are e-mail only**, to the addresses in `alert_emails`. They are passed at plan time
  (`TF_VAR_alert_emails`) and never committed. If the applied plan had none, prod's alerts open incidents in
  the Cloud Monitoring console and e-mail nobody (`variables.tf`, `alerting.tf`). Check that prod has channels:

  ```bash
  gcloud beta monitoring channels list --project "$PROJECT" --account "$ACCOUNT" \
    --format='value(displayName,labels.email_address)'
  ```

  Each one is named `algominutes-prod alerts: <address>`. No output means nobody is e-mailed.
- **Alert names** all start `algominutes-prod: `. Each alert's documentation (shown in the e-mail and the
  incident) says what to look at. The log-based ones are named after their log event (`jsonPayload.msg`), for
  example `algominutes-prod: dead_letter_recorded`. Incidents auto-close an hour after the condition clears.
- **The site's uptime alert** (`algominutes site down (<host>)`) lives in the one project that sets
  `site_uptime_host`. Today that is staging (`envs/staging/main.tf`), so it e-mails staging's `alert_emails`.
  TODO(verify): move `site_uptime_host` to prod at Apply P, as `variables.tf` says ("staging until prod exists,
  then prod"); `envs/prod/main.tf` doesn't set it yet.
- **A failed production deploy** opens (or comments on) a GitHub issue labelled `prod-deploy-failed`
  (`deploy-production.yml`, `report-failure`). It notifies whoever watches the repo's issues.
- **Budget alerts** e-mail the billing account's admins (`budget.tf`; resume-staging runbook, "Budget alerts").
- **A user's support request** fires `algominutes-prod: support_request_created` (answer within one working day,
  `docs/runbooks/testflight-internal.md`, Triage feedback).

TODO(verify): RELEASE.md Stage 2 plans "alert channels beyond e-mail (O4)". Update this section when that lands.

## 2. The first five minutes

1. Note the time, the alert's name, and any `traceId`, `noteId` or `userId` in it.
2. Is a deploy running, or did one just finish?

   ```bash
   gh run list --workflow deploy-production.yml --limit 5
   ```

   A deploy that started the trouble is the first suspect: go to §4 (roll back).
3. Find the section:

| Alert or symptom | Go to |
|---|---|
| `api down (/v1/health)`, `billing down (/health)`, `api/billing 5xx` | §3 Prod is down |
| `readiness_db_unreachable`, `auth_account_check_failed`, `Cloud SQL near its limits` | §3, step 4 (Postgres) |
| `dead_letter_recorded`, `note_failed`, `*_last_attempt_dead_letter_only`, `dead_letter_record_failed`, `lost_work_redriven`, a user's note "stuck" | §5 A note is stuck |
| `the sweep hasn't finished a run in 45 minutes`, `sweep_step_failed`, `a Cloud Scheduler job failed` | §5.3 The sweep |
| `a task queue is backing up` | §5.4 Queues |
| `gemini_transient`, `gemini_rate_limited`, `gemini_model_exhausted`, `gemini_attempt_timeout`, `gemini_model_unavailable` | the alert's own text; notes slow down, then fail after the summarize queue's retries (about an hour) |
| `spend_cap_tripped` | the alert's own text: recordings are refused and refunded until the day turns |
| `storage_purge_stuck`, `delete_account_incomplete`, `stripe_cancellation_stuck`, `recall_purge_exhausted` | the alert's own text (deletion and billing promises) |
| A feature must disappear from the apps now | §6 Kill switches |
| Data is gone or wrong | §8 Data loss |
| The site is down | `docs/runbooks/site.md`, Roll back |

## 3. Prod is down

1. **Is it the service or the network?** From your machine:

   ```bash
   API=$(gcloud run services describe api --region "$REGION" --project "$PROJECT" --account "$ACCOUNT" --format='value(status.url)')
   BILLING=$(gcloud run services describe billing --region "$REGION" --project "$PROJECT" --account "$ACCOUNT" --format='value(status.url)')
   curl -s "$API/v1/health"; echo                                    # {"status":"ok",...}: no auth, no database
   curl -s -o /dev/null -w '%{http_code}\n' "$API/v1/health/ready"    # 200: reaches Postgres
   curl -s "$BILLING/health"; echo                                   # ok
   curl -s -o /dev/null -w '%{http_code}\n' "$BILLING/health/ready"
   ```

   Health paths: probe `/health` and `/v1/health` from outside; Cloud Run's front end reserves paths ending in
   `z` (`/healthz` returns Google's 404).
2. **What is each service running?**

   ```bash
   for s in api billing meetings transcoder summarizer embedder extractor notifier; do
     printf '%-11s ' "$s"
     gcloud run services describe "$s" --region "$REGION" --project "$PROJECT" --account "$ACCOUNT" \
       --format='value(spec.template.spec.containers[0].image)'
   done
   ```

   Every image should be `$AR/<service>:<sha>` for a commit on `main`. **`us-docker.pkg.dev/cloudrun/container/hello`
   is Terraform's placeholder**: that service lost its image to a Terraform apply (a saved plan resets Cloud Run
   images, `docs/runbooks/meetings.md`). Redeploy (§4.4).
3. **What is it logging?**

   ```bash
   gcloud logging read 'resource.type="cloud_run_revision" AND resource.labels.service_name="api" AND severity>=ERROR' \
     --project "$PROJECT" --account "$ACCOUNT" --freshness=30m --limit 50 \
     --format='value(timestamp,jsonPayload.msg,jsonPayload.traceId)'
   ```

   Change `service_name` for other services. Everything one request or recording did, across every service:
   `jsonPayload.traceId="<traceId>"` (docs/SLO.md). Error Reporting groups errors by stack.
4. **Postgres** (`readiness_db_unreachable`, `auth_account_check_failed`, `/v1/health/ready` not 200):

   ```bash
   gcloud sql instances describe algominutes-prod-pg --project "$PROJECT" --account "$ACCOUNT" \
     --format='value(state,settings.activationPolicy)'                # RUNNABLE ALWAYS
   gcloud compute networks vpc-access connectors list --region "$REGION" --project "$PROJECT" --account "$ACCOUNT"
   ```

   Then the dashboard **algominutes-prod: pipeline** and the `Cloud SQL near its limits` alert (CPU, connections
   against `sql_connections_alert`). Connections are capped by `infra/terraform/envs/prod/connection-budget.json`
   (each service's `max_instances` and `pool_max`, which becomes `PG_POOL_MAX`; `tests/connection-budget.test.ts`
   checks the sum fits the tier). Changing it is a Terraform change (§6, how to plan). TODO(verify): what to
   change first when connections are the cause.
5. **Everything at once:** the deploy's own smoke runs from a laptop too. It checks every `*_URL` env, that api
   and billing answer without auth, their readiness, and that every worker answers 403 without auth:

   ```bash
   CLOUDSDK_CORE_ACCOUNT="$ACCOUNT" PROJECT="$PROJECT" REGION="$REGION" bash scripts/smoke-staging.sh
   ```

6. **If a deploy caused it, roll back (§4). If not:** check Google Cloud's status for Cloud Run, Cloud SQL and
   Vertex AI in `australia-southeast1`, and Firebase Authentication's.
7. Post the status message (§7) once you know it's real and not a blip.

## 4. Roll back a Cloud Run service

What a release does (`deploy-production.yml`, identical to `deploy-staging.yml` but for `main`): build every
changed image, tagged with the commit (`$AR/<service>:<sha>`) → `db-job` and `db-sweep` pointed at the new
`db-job` image → **migrations applied** → a Vertex smoke → rollout in waves, each `gcloud run services update
<svc> --image ...` (image only; env stays Terraform's) → the smoke → the sweeper resumed. The waves:

| Wave | Services | Why |
|---|---|---|
| 1 | transcoder, summarizer, embedder, extractor, notifier | the workers, live before anyone sends them new-shape tasks |
| 2 | meetings | queues the transcoder's runs |
| 3 | api | queues everyone's work |
| solo | billing | takes nobody's tasks, gates nothing |
| none | db-job, db-sweep | Cloud Run jobs; the migrate step points them at the new image |

**Roll back in the reverse order: api, then meetings, then the workers.** A service goes live only after every
service it hands work to, so an old worker never receives a task in a newer shape. Rolling a worker back while
the api is still new would undo that. Billing can be rolled back on its own.

**Migrations are never rolled back.** They are expand-only, so an older image keeps working on the newer schema
(`scripts/check-migration-expand.mjs`). The exception is a migration carrying a `-- contract:` marker
(`027_dead_letter_once.sql`, `040_upload_sessions_unknown_length.sql` today): before rolling a service back to an
image older than a contract migration, read its marker and check the older image is compatible. If it isn't,
roll forward instead (§4.4). The same holds for TLS: never roll back to an image older than the "one Postgres
connection config" change (#15); it can't connect (`resume-staging-and-deploy.md`, TLS ordering).

### 4.1 Find the last good revision

```bash
SVC=api
gcloud run revisions list --service "$SVC" --region "$REGION" --project "$PROJECT" --account "$ACCOUNT" --limit 5
gcloud run revisions describe <revision> --region "$REGION" --project "$PROJECT" --account "$ACCOUNT" \
  --format='value(spec.containers[0].image)'            # the image tag is the commit
gh run list --workflow deploy-production.yml --status success --limit 5   # the last green deploys and their commits
```

### 4.2 Fastest: send all traffic to the previous revision

No new revision, no build. The old revision keeps the env it was created with.

```bash
gcloud run services update-traffic "$SVC" --to-revisions=<good-revision>=100 \
  --region "$REGION" --project "$PROJECT" --account "$ACCOUNT"
```

This pins the service to that revision. **A later `gcloud run services update --image` (every deploy) creates a
revision that gets no traffic until you un-pin it.** After the fix has deployed (§4.4):

```bash
gcloud run services update-traffic "$SVC" --to-latest --region "$REGION" --project "$PROJECT" --account "$ACCOUNT"
```

TODO(verify): whether a Terraform apply resets a pinned traffic split (`cloud-run.tf` sets no `traffic` block).
Try it on staging in the drill.

### 4.3 Or: roll out an older image with today's env

Use this when the env has changed since the good revision (a Terraform apply in between), or the good revision
is gone. It is exactly the deploy's rollout step, with an older tag:

```bash
GOOD=<full sha of the last good commit on main>
gcloud run services update "$SVC" --image "$AR/$SVC:$GOOD" --region "$REGION" --project "$PROJECT" --account "$ACCOUNT" --quiet
```

The image must exist: only services a deploy built at that commit have a tag for it (a deploy builds changed
services, plus `db-job` always). Check first:

```bash
gcloud artifacts docker images describe "$AR/$SVC:$GOOD" --project "$PROJECT" --account "$ACCOUNT"
```

Optionally, from a checkout of `$GOOD`, run the deploy's preflight: it fails if the live env lacks a variable
that image needs.

```bash
gcloud run services describe "$SVC" --region "$REGION" --project "$PROJECT" --account "$ACCOUNT" --format=json \
  | node scripts/check-live-env.mjs "$SVC"
```

**The jobs.** `db-job` and `db-sweep` run the `db-job` image. If the sweep is what broke:

```bash
gcloud run jobs update db-sweep --image "$AR/db-job:$GOOD" --region "$REGION" --project "$PROJECT" --account "$ACCOUNT" --quiet
```

Never execute `JOB_NAME=migrate` from an older image: it refuses a head that disagrees with its own
(`EXPECTED_MIGRATION_HEAD`), and the schema doesn't go back.

### 4.4 Roll forward (the real fix)

You can't deploy an older commit through the pipeline: `deploy-production.yml` deploys `main`'s head, and the
WIF provider accepts tokens only from `refs/heads/main` in the `production` Environment.

1. Revert the bad PR, or fix it, in a PR into `integration`. Let it deploy to staging green
   (`scripts/train.sh <pr>`).
2. Open the promotion PR `integration` → `main` (`promotion-guard` refuses anything else). It carries
   **everything** on `integration` not yet on `main`: check `git log origin/main..origin/integration` first.
3. The merge starts `deploy-production.yml`; the owner approves the run in the `production` Environment.
4. To redeploy what is on `main` already (after a Terraform apply reset the images, or a hung run):

   ```bash
   gh workflow run deploy-production.yml --ref main -f services=all    # or -f services=api,summarizer
   gh run watch
   ```

   A full run takes roughly 12–20 minutes, from staging's measured job times in the workflow (the CI gate about
   7, migrate 2–9, each wave about a minute, the smoke a minute). A job stuck in "waiting" isn't covered by a
   timeout: cancel the run and re-run it.
5. If you pinned traffic (§4.2), un-pin it (`--to-latest`) once the new revision is the one you want.
6. Evidence that it's fixed: the deploy's smoke green, the alert closed, and the log line or query that showed
   the failure now showing success (CLAUDE.md §4.2, §4.6: a revision number is not evidence).

To stop a deploy that is making things worse: `gh run cancel <run-id>`. Services already rolled out stay on the
new image, later waves stay on the old one; a run cancelled as a whole opens no issue.

## 5. A note is stuck

### 5.1 What happens on its own

A note is in flight while its status is `queued`, `chunking`, `transcribing` or `summarizing`
(`IN_FLIGHT_STATUSES`, `packages/db/src/notes-repo.ts`).

| When | What | Log event |
|---|---|---|
| a task fails | Cloud Tasks retries it: 10 attempts, backoff up to 600 s; summarize rides out about an hour | `gemini_transient`, … |
| the last attempt fails | the worker dead-letters it and fails the note | `dead_letter_recorded`, `note_failed` (or `*_last_attempt_dead_letter_only` when the note couldn't be failed) |
| 90 min after a summary or embed was claimed with no progress | the sweep enqueues its task again (once per window) | `lost_work_redriven` |
| 3 h 30 min in flight with no progress (`STUCK_NOTE_MS`) | the sweep fails it, refunds its minutes (a regeneration isn't refunded), dead-letters it (`queue = 'sweep'`, `reason = 'stuck_in_flight'`), and the user gets a "failed" notice | `note_failed_stuck` |
| 10–40 min after Postgres finished a note whose Firestore doc disagrees | the sweep repairs the mirror | `mirror_repaired` |
| an upload no note followed within 30 min | reported once; the app re-sends the kickoff when it next runs | `upload_never_processed` |
| a note held for minutes | queued by the sweep once its author has minutes | `resume_held_notes` step |
| notetaker work whose task was lost | `meetings-reconcile` re-drives it every 15 min | `notetaker_reconcile_*` |

The sweep (`services/db-job/src/handlers/sweep.js`) is the `db-sweep` Cloud Run Job, started by the Cloud
Scheduler job `db-sweep` every 15 minutes (`sweep_schedule`, UTC), 900 s timeout, no retries (the next tick is
the retry). An advisory lock stops two runs overlapping (`sweep_already_running`). Each run logs `sweep_done`
with its counts, failures and per-step durations. Once the user sees "failed", the app's Try again re-queues it.

### 5.2 Find out what one note is doing

1. From the user: their User ID (Settings) and the note. From logs:

   ```bash
   gcloud logging read 'jsonPayload.noteId="<noteId>"' --project "$PROJECT" --account "$ACCOUNT" \
     --freshness=1d --limit 100 --format='value(timestamp,resource.labels.service_name,jsonPayload.msg,jsonPayload.traceId)'
   ```

   Then follow its `traceId` (`jsonPayload.traceId="<traceId>"`) across every service.
2. Ask Postgres, the source of truth, not the app's view (CLAUDE.md §4.4). Open **Cloud SQL Studio** on
   `algominutes-prod-pg` as in `docs/runbooks/restore-drill.md` §2, and read only:

   ```sql
   SELECT id, status, updated_at, queued_at FROM notes WHERE id = '<noteId>' AND deleted_at IS NULL;
   SELECT id, queue, reason, attempts, trace_id, created_at, resolved_at FROM dead_letter WHERE note_id = '<noteId>';
   ```

   Every note in flight with no progress for 90 minutes:

   ```sql
   SELECT id, status, updated_at FROM notes
    WHERE status IN ('queued','chunking','transcribing','summarizing') AND deleted_at IS NULL
      AND updated_at < NOW() - INTERVAL '90 minutes'
    ORDER BY updated_at;
   ```

   Read ids and statuses; don't copy transcript or summary text out of the database.
3. Postgres says `ready` but the app shows it in progress: the mirror. The sweep's `mirror_repair` fixes it
   within 40 minutes; nothing to do by hand.

**Never fix a note with an `UPDATE` in Cloud SQL Studio or an edit in the Firestore console.** Every note
mutation goes through the repo layer, Postgres first, then the mirror (CLAUDE.md §1). A hand-written status
change skips the refund, the notice and the mirror. TODO(verify): there is no operator tool to fail or re-drive
one chosen note; until there is, the options are the sweep (below) and the user's Try again.

### 5.3 The sweep

Its state, its last runs, and its last result:

```bash
gcloud scheduler jobs describe db-sweep --location "$REGION" --project "$PROJECT" --account "$ACCOUNT" --format='value(state)'
gcloud run jobs executions list --job db-sweep --region "$REGION" --project "$PROJECT" --account "$ACCOUNT" --limit 5
gcloud logging read 'jsonPayload.msg="sweep_done" OR jsonPayload.msg="sweep_step_failed"' \
  --project "$PROJECT" --account "$ACCOUNT" --freshness=2h --limit 10 \
  --format='value(timestamp,jsonPayload.msg,jsonPayload.step,jsonPayload.failures,jsonPayload.counts)'
```

**Run it now**, without waiting for the tick (it's idempotent and locked, so overlapping a scheduled run is
safe). Use `db-sweep`, not `db-job` with `JOB_NAME=sweep`: the sweep's grants (Firebase Auth user deletion,
the recordings bucket, its Cloud Tasks role) are on `db-sweep`'s own service account only (`scheduler.tf`).

```bash
gcloud run jobs execute db-sweep --region "$REGION" --project "$PROJECT" --account "$ACCOUNT" --wait
```

**Hold it** (an incident where the sweep makes things worse, or a rollback in progress):

```bash
gcloud scheduler jobs pause db-sweep --location "$REGION" --project "$PROJECT" --account "$ACCOUNT"
gh variable set SWEEPER_HOLD --body true     # so the next deploy doesn't resume it
```

While it's paused nothing is re-driven, no stuck note is failed or refunded, and deletions aren't purged
(SLO 6). `the sweep hasn't finished a run in 45 minutes` will fire, and should: leave it open. To resume:

```bash
gh variable delete SWEEPER_HOLD
gcloud scheduler jobs resume db-sweep --location "$REGION" --project "$PROJECT" --account "$ACCOUNT"
```

`SWEEPER_HOLD` is a repository variable shared with staging: while it's `true`, staging's deploys don't resume
staging's sweep either.

### 5.4 Queues

Six Cloud Tasks queues, one per stage: `transcode` → transcoder, `summarize` → summarizer, `embed` → embedder,
`extract` → extractor, `notify` → notifier, `meetings` → meetings (`modules/environment/main.tf`).

```bash
gcloud tasks queues describe summarize --location "$REGION" --project "$PROJECT" --account "$ACCOUNT"
```

`a task queue is backing up` means more than 50 tasks waited for 15 minutes: look at that worker's errors and
instance count. A queue can be paused to stop a crashing worker burning every task's attempts; its tasks wait,
they aren't lost:

```bash
gcloud tasks queues pause transcode --location "$REGION" --project "$PROJECT" --account "$ACCOUNT"
gcloud tasks queues resume transcode --location "$REGION" --project "$PROJECT" --account "$ACCOUNT"
```

TODO(verify): a paused queue's tasks still age; check against the stuck-note clock (a note paused long enough is
failed by the sweep at 3 h 30 min) before pausing for long. Rehearse it on staging (RELEASE.md R12.4 §5).

### 5.5 Dead letters

Every task out of attempts, and every note the sweep gave up on, gets a row in `dead_letter`, and
`dead_letter_recorded` fires. SLO 5: every one reviewed within one working day.

The admin view is two api routes, behind sign-in and the `ADMIN_UIDS` allowlist (`services/api/src/routes/index.js`,
`middleware/admin.js`). Anyone else gets 403 (`admin_access_denied`). `ADMIN_UIDS` comes from `TF_VAR_admin_uids`
at plan time; a plan made without it leaves every admin route at 403.

| Route | What |
|---|---|
| `GET /v1/admin/dead-letters` | unresolved entries; `?queue=<queue>`, `?includeResolved=true`, `?limit=<n>` (default 200, at most 1000) |
| `POST /v1/admin/dead-letters/<id>/resolve` | marks it resolved, with your uid as `resolved_by` |

```bash
TOKEN=<a Firebase ID token for a uid in ADMIN_UIDS>
curl -s "$API/v1/admin/dead-letters" -H "Authorization: Bearer $TOKEN" -H 'X-AlgoMinutes-Client: ops/1.0.0' | jq
curl -s -X POST "$API/v1/admin/dead-letters/<id>/resolve" -H "Authorization: Bearer $TOKEN" -H 'X-AlgoMinutes-Client: ops/1.0.0'
```

TODO(verify): how an admin gets an ID token for these calls; no script or page in the repo does it, and there
is no admin UI for dead letters.

Each entry carries `queue` (`transcode`, `summarize`, `embed`, `meetings`, or `sweep` for a stuck note), `noteId`,
`workspaceId`, `error`, `reason`, `attempts` and `traceId`; metadata only, never PII. For each:

1. Follow its `traceId` (§5.2) to the cause.
2. Fix the cause, or log it as a bug (CLAUDE.md §4.3).
3. Check the note's state in Postgres: failed (the user can Try again) or still stuck.
4. Then resolve it. **Resolving replays nothing**: it only marks the row. Don't resolve an entry whose note is
   still stuck and unexplained.

## 6. Kill switches

The apps read `GET /v1/config` (`services/api/src/routes/app-config.js`). The api reads its env on every request;
there is no cache.

| Switch (Terraform variable, `envs/prod/main.tf`) | api env | Off means |
|---|---|---|
| `broadcast_capture` (`on`/`off`, default `on`) | `BROADCAST_CAPTURE` | "Record a call" (the broadcast extension) hidden |
| `notetaker_surfaces` (default empty = off) | `NOTETAKER` | the notetaker hidden; new requests answer 503 (`docs/runbooks/meetings.md`) |
| `share_links` (module default `off`; prod doesn't expose it) | `SHARE_LINKS` | share links hidden |

**How long clients take to see it:** iOS asks at launch, at sign-in, and every time the app returns to the
foreground (`AppEnvironment.refreshSwitches`, `RootView`); offline, it keeps the last answer. The web app asks
when a page that uses a switch loads. So: as soon as the new api revision serves, plus the user's next
foreground or page load.

**How to flip one.** Env is Terraform's, so it's a reviewed plan that the owner applies, then a redeploy.

```bash
cd infra/terraform/envs/prod
export GOOGLE_OAUTH_ACCESS_TOKEN=$(gcloud auth print-access-token --account="$ACCOUNT")
export TF_VAR_billing_account=$(gcloud billing projects describe algominutes-prod \
  --account="$ACCOUNT" --format='value(billingAccountName)' | sed 's#billingAccounts/##')
# A saved plan fixes its variables. Re-export EVERY plan-time value the last applied plan had, or this plan
# removes them: the alert e-mails (alerts then e-mail nobody), ADMIN_UIDS (the admin view then answers 403),
# and the switches you are not changing.
export TF_VAR_alert_emails='[...]'
export TF_VAR_admin_uids='[...]'
export TF_VAR_notetaker_surfaces='...'
export TF_VAR_broadcast_capture=off          # the change
terraform init
SHA=$(git rev-parse --short HEAD)
terraform plan -lock=false -var-file=terraform.tfvars -out "reviewed-$SHA.tfplan"   # read it: only the api's env should change
terraform show -json "reviewed-$SHA.tfplan" > /tmp/plan.json
node ../../../../scripts/check-tfplan-env.mjs /tmp/plan.json                       # must say OK
```

The owner applies it (`terraform apply reviewed-<sha>.tfplan`, after the "plan is current" check in the
resume-staging runbook §1), and then, at once, the redeploy (§4.4, `-f services=all`), **because a saved plan
resets Cloud Run images** (`docs/runbooks/meetings.md`, BLOCKERS Apply A): until the redeploy finishes, the
services it reset run the placeholder. Check every image afterwards (§3 step 2).

TODO(verify): which services an apply resets (every one, or only those whose template changed). If it's every
service, flipping a switch costs a 12–20 minute outage. Measure it in the Stage 4 kill-switch drill, and decide
whether an emergency flip may be done with `gcloud run services update api --update-env-vars BROADCAST_CAPTURE=off`
instead (a change Terraform doesn't know about until the next plan; if allowed, record the decision in
`docs/DECISIONS.md` and make the same change in Terraform straight after).

**One tester's notetaker**, no deploy: the `grant-notetaker` db-job handler with `MODE=revoke`
(`docs/runbooks/meetings.md`). Bots already scheduled at Recall still join: cancel them from the note or in
Recall's dashboard.

**Spend:** `DAILY_SPEND_CAP_AUD` (`daily_spend_cap_aud`) refuses, and refunds, every new recording once the day's
paid audio reaches it (`spend_cap_tripped`). Prod's is A$60 a day (`daily_spend_cap_aud = 60`, #469); raising it
is a Terraform change like a switch, above.

**A bad app build:** TestFlight, expire it (`docs/runbooks/testflight-internal.md`, Pull a bad build). After the
App Store launch, a P0 pauses the phased release (RELEASE.md, After launch). The api's 426 "please update" gate
compares the marketing version only (`MIN_SUPPORTED_CLIENT` in `packages/contracts/src/version.ts`, a contract
change).

## 7. The status message

There is no status page, no in-app banner, and no message field in `/v1/config` (PROD-READINESS O6). What exists
today:

1. **Replies.** Users who write in arrive as `support_request_created` and at `support@algorythmos.com`. Answer
   each with the same short message.
2. **TestFlight testers:** tell the group (App Store Connect → TestFlight).
3. **The site.** A notice on `/support` (`apps/site/src/pages/support.astro`; the `.notice` style already
   exists). It reaches the public only through a PR into `integration` and a promotion PR to `main`, and that
   promotion carries everything else on `integration` too (§4.4 step 2), backend included. A site-only promotion
   deploys no service (`deploy-production.yml`'s paths don't include `apps/site`).

The message, plain and short:

> Since <time, AEST/AEDT>, <what users see: e.g. new recordings aren't being summarised>. Your recordings are
> safe and will be processed once it's fixed; any minutes for recordings that fail are refunded. We'll update
> this by <time>.

Only say "refunded" when it's true: the sweep refunds a note it fails as stuck; a failed regeneration isn't
refunded. Remove the notice the same way once it's over.

TODO(verify): the owner to decide whether 1.0 needs a faster channel (a status page, or a message field in
`/v1/config`, which is a three-client contract change).

## 8. Data loss

Postgres is the source of truth; Firestore is a cache rebuilt from it (CLAUDE.md §1). Point-in-time recovery is
proven by `docs/runbooks/restore-drill.md`: clone `algominutes-prod-pg` to a point in time, compare, and read
what you need from the clone. Don't improvise a restore over the live instance.

TODO(verify): there is no procedure for putting restored data back into the live instance, or for switching the
services to a restored instance. Recordings in Cloud Storage aren't versioned, so a deleted recording is gone
(restore-drill.md, What this doesn't cover).

## 9. Afterwards

1. Write down what happened, when, the evidence of the fix, and what's left, with every `traceId` you followed.
   TODO(verify): where incident records go (the repo records evidence in `docs/BLOCKERS.md`; an incident log
   section doesn't exist yet).
2. Each P0/P1 fix ships with a regression test (`testflight-internal.md`, Triage feedback).
3. Undo every temporary change: un-pin traffic (§4.2), resume the sweep and delete `SWEEPER_HOLD` (§5.3), resume
   paused queues (§5.4), remove the status notice (§7).
4. A real secret exposed in git: rotate it, then purge it (CLAUDE.md §1).

## 10. What not to do

From CLAUDE.md and the runbooks, and they hold during an incident too:

- **Never edit a committed migration**, or run SQL DDL by hand. Fix forward with a new, expand-only migration
  (CLAUDE.md §6, BUILD-PLAN §4.4).
- **Never write a note's state directly**: no `UPDATE` in Cloud SQL Studio, no edit in the Firestore console, no
  `noteRef.update(...)` from a script. Every note mutation goes through the repo layer in `@algominutes/db`
  (CLAUDE.md §1).
- **Never set `cors: true`, or widen CORS outside `ALLOWED_ORIGINS`** (Terraform `allowed_origins`), and **never
  disable CSP in production** without recording the decision in `docs/DECISIONS.md` (CLAUDE.md §1).
- **Never `terraform apply` without a reviewed saved plan** made from the current commit and passed by
  `scripts/check-tfplan-env.mjs`; the owner applies it (resume-staging runbook §1). And redeploy right after
  (§6).
- **Never mute, snooze or filter an alert** to quiet it. Known issues stay visible until fixed (CLAUDE.md §4.8).
- **Never merge into `main` except the promotion PR from `integration`** (`promotion-guard`), and don't roll back
  across a `-- contract:` migration or below the TLS change (§4).
- **Never commit secrets or prod config** (alert e-mails, admin uids, Firebase configs, the prod plist); they are
  passed at plan time or stay git-ignored (CLAUDE.md §1).
- **Never resolve a dead letter you haven't explained**: resolving replays nothing (§5.5).
- **Never claim it's fixed from a deploy or a revision number.** Close with a query result or a log line
  (CLAUDE.md §4.2, §4.6).
