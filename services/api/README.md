# services/api — the one HTTP edge

`@algominutes/api` is the **single** Cloud Run HTTP service for all three
clients (web, iOS, Android). It replaces the source's **two** overlapping HTTP
surfaces — the Express `server.ts` dev/prod host **and** the Firebase Functions
handlers — with one service, one auth path, one CORS config, and one place a
request-handling bug can live (BUILD-PLAN §3.1).

Everything ported here **preserves the source behaviour exactly**. The
framework-agnostic handlers (`src/routes/*.cjs`) are copied verbatim from
`functions/`; the only change is that their shared libraries are now *imported*
from the workspace packages instead of copied in:

- `@algominutes/db` → `pg-query.cjs` (pool + per-query timeout), `notes-repo`
  (the note dual-write layer: `markReady` / `markError` / `applyNoteEdit`).
- `@algominutes/ai` → `intelligence.cjs`, `redaction.cjs`, `share-links.cjs`,
  `note-edit.cjs`, `logger.cjs`.

No shared lib is duplicated into this service.

## Route table (`/v1` prefix)

Every endpoint is versioned from day one. Handlers take their identifiers
(`noteId`, `workspaceId`, …) in the JSON body, exactly as the clients already
send them.

| Method | Path | Auth | Source it came from |
|---|---|---|---|
| `GET`  | `/v1/health`         | none | `server.ts` `/api/health` |
| `POST` | `/v1/process-audio`  | ID token | `server.ts` `/api/process-audio` (sync transcribe+summarize) |
| `POST` | `/v1/process`        | ID token | `functions/index.js` `processIntelligence` (async kickoff) |
| `POST` | `/v1/notes/read`     | ID token | `functions/note-read.cjs` `handleNoteRead` (= `server.ts` `/api/note`) |
| `POST` | `/v1/notes/update`   | ID token | `server.ts` `/api/update-note` (updateNote twin, `applyNoteEdit`) |
| `POST` | `/v1/notes/regenerate-summary` | ID token | `functions/index.js` `regenerateSummary` |
| `POST` | `/v1/notes/feedback` | ID token | `functions/index.js` `noteFeedback` |
| `POST` | `/v1/export`         | ID token | `functions/export-note.cjs` `handleExportNote` (binary DOCX) |
| `POST` | `/v1/search`         | ID token | `functions/search-and-chat.cjs` `handleSearch` |
| `POST` | `/v1/chat`           | ID token | `functions/search-and-chat.cjs` `handleChatStream` (SSE) |
| `POST` | `/v1/shares/create`  | ID token | `functions/index.js` `shareCreate` |
| `POST` | `/v1/shares/revoke`  | ID token | `functions/index.js` `shareRevoke` |
| `POST` | `/v1/shares/read`    | **public** (token is the credential) | `functions/shared-note.cjs` `handleSharedNote` |
| `POST` | `/v1/client-error`   | **public** (crash beacon; version-gate exempt) | `functions/index.js` `clientError` |
| `POST` `DELETE` | `/v1/account/delete` | ID token (self-verified) | `functions/delete-account.cjs` `handleDeleteAccount` |

Every endpoint that was an HTTP `onRequest` handler in `functions/index.js` now
lives here. `functions/` retains only genuine triggers (see below).

### One auth path

A single Firebase ID-token verification middleware
(`src/middleware/auth.js`) runs in front of every authenticated route and
hands the handler a verified `req.uid`. The source verified tokens in eleven
places; there is now one.

- `/v1/shares/read` and `/v1/client-error` are the only unauthenticated
  endpoints — a share token *is* its own credential, and the crash beacon is
  deliberately anonymous (the crash before sign-in is the one worth hearing).
  Both are also exempt from the client-version gate.
- `/v1/account/delete` self-authenticates with the **same** `verifyIdToken`
  primitive because its ported handler owns its whole method/OPTIONS envelope.

### One CORS config

`src/middleware/cors.js` reads `ALLOWED_ORIGINS` (comma-separated) and adds it
to the source's default origins — the Functions default set, which is the
superset that keeps the native (Capacitor/Ionic) clients working:
`http://localhost:3000`, `http://127.0.0.1:3000`, `https://localhost`,
`capacitor://localhost`, `ionic://localhost`. Requests with no `Origin`
(server-to-server, native WebViews, curl) are allowed, as before.

> Production origins (`https://algominutes.com`, `https://api.algominutes.com`)
> are supplied at deploy time via `ALLOWED_ORIGINS`; only the localhost dev
> origins are baked in.

## Client-version gate

Every client must send a version header:

```
X-AlgoMinutes-Client: <platform>/<semver>     e.g.  ios/1.0.0, web/1.0.0, android/1.0.0
```

`src/middleware/client-version.js` parses it and:

- **Below the minimum** for a *known* platform → **426 Upgrade Required** with a
  friendly body — never a 500:
  ```json
  { "error": "please_update", "message": "Please update AlgoMinutes to continue." }
  ```
- **Missing** header → clear **400** (`client_version_required`).
- **Malformed** header → clear **400** (`invalid_client_version`) — parsing can
  never throw a 500.
- **Unknown** platform → allowed through (lenient — a client we have not
  enumerated is not locked out).

Minimums live in a constant map (`MIN_SUPPORTED_CLIENTS`) with **generous
defaults** (`1.0.0` everywhere), so no currently-shipping client is gated;
raising a floor is a one-line edit. The health check, the public share read,
and the crash beacon (`/v1/client-error`) are exempt from the gate.

## Structured logging invariant

`src/middleware/trace.js` establishes a per-request `traceId` and attaches a
child of the shared `@algominutes/ai` logger to `req.log`. Auth adds
`uid`/`userId`; the ported handlers add `noteId`/`workspaceId`. Every log line
therefore carries the trace identity plus whatever correlation fields exist —
the CLAUDE.md §2 invariant, preserved.

## What stays a Firebase Function

**Every** HTTP `onRequest` handler that was in `functions/index.js` has moved
here — the async kickoff (`processIntelligence`), `regenerateSummary`,
`shareCreate`, `shareRevoke`, `noteFeedback`, and the `clientError` beacon
included. No Firebase Function serves an HTTP endpoint `services/api` also
serves.

The only handler that must **not** move is the genuine trigger:

- **`onNoteDeleted`** (`functions/index.js`) — a Firestore `onDocumentDeleted`
  trigger on `workspaces/{wsId}/notes/{noteId}`. It is the GDPR/App-Store
  storage+Postgres cascade that `/v1/account/delete` relies on (account deletion
  deletes the note docs, which fire this trigger). It is event-bound to
  Firestore and cannot be expressed as an HTTP route, so it stays a Function.

### How the ported handlers' infra was repointed

The index.js-local infrastructure was routed through the workspace packages
rather than re-created:

- **pg pool factory** (`functions/index.js` `pgPool()`, `max: 4`) → the shared
  `@algominutes/db` `pg-query.cjs` `pool()` — one pool for the whole service.
  `hydratePgEnv()` (Firebase-param → `process.env`) is dropped; on Cloud Run the
  `PG*` / `WRITE_POSTGRES` vars are set directly in the environment `pool()`
  reads.
- **`upsertNoteQueued`** and the **regenerate claim / probe / unclaim SQL** have
  no repo function, so the SQL stays inside the ported route files but executes
  on the **shared** `pool()`, never a local one.
- **Cloud Tasks enqueue** → `@algominutes/ai` `cloud-tasks.cjs` `enqueueTask`.
- **`validateStoragePath`** → `@algominutes/db` `storage-paths.cjs`.
- **feedback / share-link / summary-template / redaction helpers** →
  `@algominutes/ai` (`note-feedback.cjs`, `share-links.cjs`,
  `summary-templates.cjs`, `redaction.cjs`).
- **Firebase `defineString` deploy params** (`TRANSCODER_URL`, `SUMMARIZER_URL`,
  `JOBS_SA_EMAIL`, `TASKS_PROJECT`, `TASKS_LOCATION`, `TASKS_QUEUE`) become plain
  Cloud Run env vars with the source's defaults.

## Running

```
npm run dev        # tsx watch, local
npm start          # tsx src/index.js
```

The service runs under **tsx** because it imports `@algominutes/db`'s
TypeScript source directly and there is no build step yet. `PORT` defaults to
`8080` (Cloud Run convention).

### Environment

| Var | Purpose |
|---|---|
| `PORT` | Listen port (default `8080`). |
| `ALLOWED_ORIGINS` | Extra CORS origins, comma-separated (added to defaults). |
| `GOOGLE_CLOUD_PROJECT` / `GCLOUD_PROJECT` | Firebase/GCP project for ADC. |
| `STORAGE_BUCKET` | Default GCS bucket (audio for `/v1/process-audio`). |
| `GEMINI_API_KEY` | Gemini key for `/v1/process-audio`. Search/chat embed + generate via Vertex ADC. |
| `WRITE_POSTGRES` | `true` enables the Postgres-backed paths; otherwise those routes 503. |
| `PGHOST` / `PGDATABASE` / `PGUSER` / `PGPASSWORD` / `DATABASE_URL` | Postgres connection (via `@algominutes/db`). |
| `AIPLATFORM_LOCATION` | Vertex region for search/chat (default `us-central1`). |
| `TRANSCODER_URL` | Cloud Run URL the `/v1/process` kickoff enqueues to. |
| `SUMMARIZER_URL` | Cloud Run URL `/v1/notes/regenerate-summary` enqueues to. |
| `JOBS_SA_EMAIL` | Service account minted into the Cloud Tasks OIDC token. |
| `TASKS_PROJECT` | Cloud Tasks project (required for `/v1/process` + regenerate). |
| `TASKS_LOCATION` | Cloud Tasks location (default `us-central1`). |
| `TASKS_QUEUE` | Cloud Tasks queue (default `audio-jobs`). |
| `LOG_CHAT_PROMPT_DEBUG` | `true` logs a redaction-tag count for the chat prompt (off in prod). |
