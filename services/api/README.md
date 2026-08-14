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
| `POST` | `/v1/notes/read`     | ID token | `functions/note-read.cjs` `handleNoteRead` (= `server.ts` `/api/note`) |
| `POST` | `/v1/notes/update`   | ID token | `server.ts` `/api/update-note` (updateNote twin, `applyNoteEdit`) |
| `POST` | `/v1/export`         | ID token | `functions/export-note.cjs` `handleExportNote` (binary DOCX) |
| `POST` | `/v1/search`         | ID token | `functions/search-and-chat.cjs` `handleSearch` |
| `POST` | `/v1/chat`           | ID token | `functions/search-and-chat.cjs` `handleChatStream` (SSE) |
| `POST` | `/v1/shares/read`    | **public** (token is the credential) | `functions/shared-note.cjs` `handleSharedNote` |
| `POST` `DELETE` | `/v1/account/delete` | ID token (self-verified) | `functions/delete-account.cjs` `handleDeleteAccount` |

### One auth path

A single Firebase ID-token verification middleware
(`src/middleware/auth.js`) runs in front of every authenticated route and
hands the handler a verified `req.uid`. The source verified tokens in eleven
places; there is now one.

- `/v1/shares/read` is the **only** unauthenticated endpoint — the share token
  *is* the credential, so it is deliberately not behind the middleware.
- `/v1/account/delete` self-authenticates with the **same** `verifyIdToken`
  primitive because its ported handler owns its whole method/OPTIONS envelope.

### One CORS config

`src/middleware/cors.js` reads `ALLOWED_ORIGINS` (comma-separated) and adds it
to the source's default origins — the Functions default set, which is the
superset that keeps the native (Capacitor/Ionic) clients working:
`http://localhost:3000`, `http://127.0.0.1:3000`, `https://localhost`,
`capacitor://localhost`, `ionic://localhost`. Requests with no `Origin`
(server-to-server, native WebViews, curl) are allowed, as before.

> Identifiers are **not** renamed — the `wassup` → `algominutes` rename is a
> later phase. Only the source's origins are carried over.

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
raising a floor is a one-line edit. The health check and the public share read
are exempt from the gate.

## Structured logging invariant

`src/middleware/trace.js` establishes a per-request `traceId` and attaches a
child of the shared `@algominutes/ai` logger to `req.log`. Auth adds
`uid`/`userId`; the ported handlers add `noteId`/`workspaceId`. Every log line
therefore carries the trace identity plus whatever correlation fields exist —
the CLAUDE.md §2 invariant, preserved.

## What stays a Firebase Function

None of the five ported HTTP handlers is trigger-bound, so all five moved.
What must **not** move:

- **`onNoteDeleted`** (`functions/index.js`) — a genuine Firestore
  `onDocumentDeleted` trigger on `workspaces/{wsId}/notes/{noteId}`. It is the
  GDPR/App-Store storage+Postgres cascade that `/v1/account/delete` relies on
  (account deletion deletes the note docs, which fire this trigger). It stays a
  Function.

Still living as **HTTP** `onRequest` handlers in `functions/index.js` and *not*
part of §3.1's named five — flagged for a follow-up consolidation pass, not
ported here: `processIntelligence` (async kickoff), `regenerateSummary`,
`shareCreate`, `shareRevoke`, `noteFeedback`, `clientError`. Their logic is
tightly bound to index.js-local infrastructure (the pg pool factory,
`upsertNoteQueued`, the regenerate claim SQL, Firebase deploy params), so
porting them faithfully is a deliberate second step.

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
| `LOG_CHAT_PROMPT_DEBUG` | `true` logs a redaction-tag count for the chat prompt (off in prod). |
