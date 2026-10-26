# Runbook: the online-meeting notetaker

The Recall.ai notetaker (docs/plans/MEETINGS.md). This runbook grows with each M1 PR.
Until the legal opinion (docs/CONSENT.md §2.4), only **allowlisted testers** can use it.

## What must be true before anyone can send a notetaker

Each check is off by default, and all of them must pass:

1. **Built:** the surface is in `NOTETAKER_BUILT` (`services/api/src/routes/app-config.js`). In M1, only `bot`.
2. **Switched on:** Terraform's `notetaker_surfaces` includes it. It sets the api's `NOTETAKER` env.
3. **Allowlisted:** the caller has a live row in `notetaker_testers` (migration 024).
4. **Configured:**
   - the api has `MEETINGS_URL` and `MEETING_URL_KMS_KEY` (Terraform sets both);
   - the meetings service can read `recall-api-key` and `recall-webhook-secret` from Secret Manager.

If 1–3 fail, `GET /v1/config` reports the notetaker off and `POST /v1/meetings/bots` answers 503
`feature_disabled`. A failed allowlist lookup also counts as off (`notetaker_tester_lookup_failed` in the api's
logs). If the api is switched on but lacks `MEETINGS_URL` or `MEETING_URL_KMS_KEY`, it logs
`notetaker_misconfigured` and answers the same 503.

## Turn it on for a tester (owner)

1. **The tester signs in to the app once,** so their user exists.
2. **Allowlist them.** Nothing about them goes into git. The grant expires after 30 days by default;
   `GRANT_DAYS=0` means it never expires.

   ```bash
   gcloud run jobs execute db-job --wait --region australia-southeast1 --project <project> \
     --update-env-vars JOB_NAME=grant-notetaker,GRANT_UID=<their User ID>
   ```

   To remove them, add `MODE=revoke`. The job logs `notetaker_tester_granted` (or `_revoked`) with their
   uid only.
3. **Switch the bot on, once per environment.** Plan with `TF_VAR_notetaker_surfaces=bot`, review the saved
   plan, apply it, then redeploy: a saved plan resets Cloud Run images.
4. **Add Recall's secrets, once per environment.** In Secret Manager, add a version to `recall-api-key` and to
   `recall-webhook-secret` (the endpoint's `whsec_…` secret). Recall's workspace for this environment must
   point its webhook at `https://<meetings url>/webhooks/recall`.

## Switch it off

- **For everyone:** plan with `TF_VAR_notetaker_surfaces=` (empty), then apply and redeploy. Clients hide the
  entry point on their next `/v1/config` fetch, and new requests answer 503.
- **For one tester:** `grant-notetaker` with `MODE=revoke`. This takes effect immediately; no deploy is needed.
- **Bots already scheduled at Recall still join.** Cancel them from the note, or in Recall's dashboard.
  (The bulk-cancel runbook step comes with PR 12's reconcile.)

## Log events worth knowing

| Event | Where | Meaning |
|---|---|---|
| `notetaker_requested` | api | A bot was reserved, its note created and `create_bot` queued. `healed: true` means an earlier half-done attempt was finished. |
| `notetaker_reserve_failed`, `notetaker_note_create_failed`, `create_bot_enqueue_failed` | api | Part of a request failed. The client's retry with the same request id finishes it. |
| `recall_bot_created`, `recall_bot_adopted` | meetings | Recall made the bot, or a replay found the one it already made. |
| `recall_auth_failed` | meetings | Recall refused our key (401/403): wrong key, or the wrong region. The task is retried, so fix the secret. |
| `recall_bot_refused` | meetings | Recall refused the link. The note fails with "couldn't find this meeting". |
| `notetaker_failed`, `notetaker_cancelled` | meetings | The bot ended without a recording. The note says why, and nothing is charged. |
| `notetaker_recorded_out_of_order` | meetings | An ending arrived before its recording event; Recall confirmed that a recording exists. |
