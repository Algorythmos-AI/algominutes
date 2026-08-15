# services/notifier (A7.3)

FCM push fan-out. A new async, fan-out-shaped Cloud Run service (§3.2): Cloud Tasks
pushes terminal-pipeline events here and we deliver them to the recipient's devices.

## Endpoints

- `GET /healthz` → `200 ok`. Liveness probe.
- `POST /` — Cloud Tasks push target (OIDC-authenticated; `--no-allow-unauthenticated`).
  Body:

  ```json
  { "type": "note_ready" | "note_failed", "noteId": "…", "workspaceId": "…", "uid": "…", "title": "…?", "body": "…?" }
  ```

  It:
  1. looks up the recipient's device tokens via `tokensForUser(uid)` (`@algominutes/db`);
  2. sends one `messaging().sendEachForMulticast({ tokens, notification, data })`, where
     `data = { type, noteId, deepLink }` and `deepLink = algominutes://note/<noteId>`;
  3. prunes any token FCM reports `UNREGISTERED` / `invalid-argument` via `deletePushToken(token)`;
  4. returns **200** when handled — including **0 tokens**, which is the on-device
     local-notification fallback's job, not an error;
  5. returns **5xx** only on a genuine transient (token lookup failed, whole-batch FCM
     throw) so Cloud Tasks retries.

## Who enqueues it

The pipeline terminal stages enqueue `notify` tasks (queue `notify`, target `NOTIFIER_URL`):

- **summarizer** — `note_ready` on success (last stage), `note_failed` on final-attempt failure.
- **transcoder** — `note_failed` on terminal failure (transcoder success is not terminal).
- **embedder** — never notifies (a failed search index does not change note readiness).

## Config (env)

- `PORT` (default 8080).
- Firebase Admin uses ADC from the bound service account (no key file).
- Postgres via the standard `@algominutes/db` env (`DATABASE_URL` or `PG*`, `WRITE_POSTGRES`).

## Operating cost (BUILD-PLAN §3.3)

This is a **new deploy surface**: its own Cloud Run service, the `notify` Cloud Tasks
queue (with a dead-letter policy), a dashboard, and an alert. Record it in
`docs/DECISIONS.md` alongside the other services before shipping.
