# Service level objectives

Targets for staging through M1 and the first TestFlight builds. Revisit them with real traffic before production.
Every one is measured from signals already emitted. The alerts that page are in
`infra/terraform/modules/environment/alerting.tf` and `monitoring.tf`, and the dashboard is
*algominutes-&lt;env&gt;: pipeline*.

| # | Objective | Target | Measured by | Alert |
|---|---|---|---|---|
| 1 | **API available** | 99.5% of 5-minute checks pass, per month | Uptime check on `GET /v1/health` (several regions) | `api down (/v1/health)`: failing from more than one region for 10 min |
| 2 | **API errors** | < 1% of api/billing requests answer 5xx, per day | `run.googleapis.com/request_count` by `response_code_class` | `api/billing 5xx`: more than 5 in 5 min |
| 3 | **A recording becomes a summary** | 95% of notes reach `ready` | `note_failed` log metric against kickoffs (`kickoff_enqueued` lines) | `note_failed`: more than 2 in 30 min |
| 4 | **Time to summary** | p95 ≤ half the recording's length + 5 min, for recordings up to 4 h | Per `traceId`: the kickoff line to `summarizer_complete` (query below) | none yet (review weekly) |
| 5 | **Nothing is lost silently** | Every dead-lettered task reviewed within 1 working day | `dead_letter_recorded`, and the admin view `GET /v1/admin/dead-letters` | `dead_letter_recorded`: any |
| 6 | **Deletion finishes** | A deleted note's doc and audio are gone within 15 min; an account's within 1 h | Sweep: `storage_purge_stuck`, `delete_account_incomplete` | both: any |

## Queries (Logs Explorer)

Time to summary, per note (objective 4). Take `timestamp` from the first query and from the second query for the same `traceId`:

```
jsonPayload.msg="kickoff_enqueued" jsonPayload.traceId="<traceId>"
jsonPayload.msg="summarizer_complete" jsonPayload.traceId="<traceId>"
```

Everything one recording did, across every service:

```
jsonPayload.traceId="<traceId>"
```

Errors grouped by cause: **Error Reporting**. Every error-level line with an `Error` carries a top-level
`stack_trace` (logger.cjs), which is what Error Reporting groups on.

## Not yet measured

- An end-to-end run that exercises all of the above on a schedule (the e2e workflow: a 10-minute fixture
  nightly, a 3-hour one weekly). It needs staging up; see BLOCKERS.
- Client-side crashes: Crashlytics, once builds reach TestFlight.
