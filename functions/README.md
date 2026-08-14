# functions/ — Firebase Functions (TRIGGERS ONLY)

All HTTP endpoints were consolidated into `services/api` (BUILD-PLAN §3.1). This deploy target holds
**only** genuine Firebase triggers that cannot be HTTP routes:

- `onNoteDeleted` — Firestore `onDocumentDeleted` on `workspaces/{wsId}/notes/{noteId}`; the GDPR /
  App-Store storage + Postgres deletion cascade that `services/api` `/v1/account/delete` relies on.

Shared logic (structured logger, pg pool) is imported from `@algominutes/ai`.

**TODO(build A11):** Firebase Functions deploy runs its own install in `functions/`; the `@algominutes/ai`
workspace dep must be vendored at deploy time (same pattern as the service Dockerfiles). Wired in A11.
