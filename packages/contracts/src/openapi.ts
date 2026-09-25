// Builds the OpenAPI v3 document FROM the zod schemas — the schemas are the
// source of truth, this file is a projection of them. `npm run openapi` runs
// scripts/generate-openapi.ts, which calls `buildOpenApiDocument()` and writes
// openapi/openapi.v1.json. Never hand-edit the emitted JSON; edit schemas here.
import {
  OpenAPIRegistry,
  OpenApiGeneratorV3,
} from '@asteasolutions/zod-to-openapi';

import { API_BASE_PATH, API_VERSION, CLIENT_VERSION_HEADER } from './version';
import { z } from './schemas/zod';
import * as S from './schemas';

/** Register every named schema as a reusable component, plus representative
 * paths under `/v1`. Kept in one function so the generator and any test share
 * exactly one registry. */
export function buildRegistry(): OpenAPIRegistry {
  const registry = new OpenAPIRegistry();

  // ── security ──────────────────────────────────────────────────────────
  const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
    type: 'http',
    scheme: 'bearer',
    bearerFormat: 'Firebase ID token',
    description: 'Firebase Auth ID token. Absent only on the public routes: POST /v1/shares/read and POST /v1/client-error.',
  });

  // ── shared header parameter (every client must send it) ─────────────────
  const clientVersionHeader = registry.registerParameter(
    'ClientVersion',
    z.string().openapi({
      param: {
        name: CLIENT_VERSION_HEADER,
        in: 'header',
        required: true,
        description:
          'Client build identifier, "<platform>/<semver>" e.g. ios/1.4.0. The server refuses unsupported builds with 426.',
      },
      example: 'ios/1.4.0',
    }),
  );

  // ── component schemas ───────────────────────────────────────────────────
  // Registering each named schema makes it a $ref target so nested uses are
  // shared rather than inlined.
  const components: Array<[string, Parameters<typeof registry.register>[1]]> = [
    ['Id', S.Id],
    ['IsoDateTime', S.IsoDateTime],
    ['DateOnly', S.DateOnly],
    ['RedactionMeta', S.RedactionMeta],
    ['ErrorEnvelope', S.ErrorEnvelope],
    ['NoteStatus', S.NoteStatus],
    ['NoteType', S.NoteType],
    ['Summary', S.Summary],
    ['FirestoreTranscriptLine', S.FirestoreTranscriptLine],
    ['NoteProgress', S.NoteProgress],
    ['Note', S.Note],
    ['TranscriptLine', S.TranscriptLine],
    ['TranscriptPage', S.TranscriptPage],
    ['SharedTranscriptLine', S.SharedTranscriptLine],
    ['SummaryTemplateId', S.SummaryTemplateId],
    ['SummaryTemplate', S.SummaryTemplate],
    ['NoteReadRequest', S.NoteReadRequest],
    ['NoteReadMeta', S.NoteReadMeta],
    ['ActionItem', S.ActionItem],
    ['KeyDecision', S.KeyDecision],
    ['NoteReadSummary', S.NoteReadSummary],
    ['NoteReadResponse', S.NoteReadResponse],
    ['NoteReadPageResponse', S.NoteReadPageResponse],
    ['SearchRequest', S.SearchRequest],
    ['SearchHit', S.SearchHit],
    ['SearchResponse', S.SearchResponse],
    ['ChatRequest', S.ChatRequest],
    ['ChatCitationsEvent', S.ChatCitationsEvent],
    ['ChatTextEvent', S.ChatTextEvent],
    ['ChatErrorEvent', S.ChatErrorEvent],
    ['ExportScope', S.ExportScope],
    ['ExportNoteRequest', S.ExportNoteRequest],
    ['ExportTooLargeError', S.ExportTooLargeError],
    ['ShareCreateRequest', S.ShareCreateRequest],
    ['ShareCreateResponse', S.ShareCreateResponse],
    ['ShareRevokeRequest', S.ShareRevokeRequest],
    ['ShareRevokeResponse', S.ShareRevokeResponse],
    ['SharedNoteRequest', S.SharedNoteRequest],
    ['SharedSummary', S.SharedSummary],
    ['SharedNoteResponse', S.SharedNoteResponse],
    ['NoteEditSummary', S.NoteEditSummary],
    ['UpdateNoteRequest', S.UpdateNoteRequest],
    ['UpdateNoteResponse', S.UpdateNoteResponse],
    ['NoteSpeaker', S.NoteSpeaker],
    ['SetNoteSpeakersRequest', S.SetNoteSpeakersRequest],
    ['SetNoteSpeakersResponse', S.SetNoteSpeakersResponse],
    ['DeleteAccountSummary', S.DeleteAccountSummary],
    ['DeleteAccountResponse', S.DeleteAccountResponse],
    ['DeleteAccountError', S.DeleteAccountError],
  ];
  for (const [name, schema] of components) registry.register(name, schema);

  // ── helpers ─────────────────────────────────────────────────────────────
  const json = (schema: Parameters<typeof registry.register>[1]) => ({
    content: { 'application/json': { schema } },
  });
  const errorResponse = (description: string) => ({
    description,
    content: { 'application/json': { schema: S.ErrorEnvelope } },
  });
  const authed = [{ [bearerAuth.name]: [] }];
  // `clientVersionHeader` is the registered ZodString schema; the component name
  // it was registered under is the literal 'ClientVersion' (first arg above).
  void clientVersionHeader;
  const commonHeaders = [{ $ref: `#/components/parameters/ClientVersion` }];

  // ── paths (representative subset, all under /v1) ─────────────────────────

  registry.registerPath({
    method: 'get',
    path: `${API_BASE_PATH}/health`,
    summary: 'Liveness probe (never touches the database).',
    tags: ['system'],
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: z.object({ status: z.literal('ok') }) } },
      },
    },
  });

  registry.registerPath({
    method: 'get',
    path: `${API_BASE_PATH}/health/ready`,
    summary: 'Readiness probe: proves the service can reach Postgres (post-deploy smoke).',
    tags: ['system'],
    responses: {
      200: {
        description: 'Postgres reachable',
        content: { 'application/json': { schema: z.object({ status: z.literal('ok'), db: z.literal('ok') }) } },
      },
      503: {
        description: 'Postgres unreachable',
        content: {
          'application/json': {
            schema: z.object({ status: z.literal('degraded'), db: z.literal('unreachable') }),
          },
        },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${API_BASE_PATH}/notes/read`,
    summary: 'Full note + paginated transcript from Postgres.',
    tags: ['notes'],
    security: authed,
    parameters: commonHeaders,
    request: { body: json(S.NoteReadRequest) },
    responses: {
      200: { description: 'Note read (first page) or transcript page.', ...json(S.NoteReadResponse) },
      400: errorResponse('Invalid noteId / workspaceId / cursor.'),
      401: errorResponse('Missing or invalid token.'),
      403: errorResponse('Workspace mismatch.'),
      404: errorResponse('Note not found (or caller is not a member).'),
      426: errorResponse('Client too old — please update.'),
      503: errorResponse('Postgres not provisioned.'),
      504: errorResponse('Query timeout.'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${API_BASE_PATH}/notes/update`,
    summary: 'Persist a manual note edit (title + summary) to Postgres.',
    tags: ['notes'],
    security: authed,
    parameters: commonHeaders,
    request: { body: json(S.UpdateNoteRequest) },
    responses: {
      200: { description: 'Edit applied.', ...json(S.UpdateNoteResponse) },
      400: errorResponse('No editable fields / invalid fields.'),
      401: errorResponse('Missing or invalid token.'),
      403: errorResponse('Not your note / workspace mismatch.'),
      404: errorResponse('Note not found.'),
      500: errorResponse('Update failed.'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${API_BASE_PATH}/notes/audio-url`,
    summary: "A short-lived signed URL to play a note's audio (the note's own object only). Never log or persist it.",
    tags: ['notes'],
    security: authed,
    parameters: commonHeaders,
    request: { body: json(S.NoteAudioUrlRequest) },
    responses: {
      200: { description: 'A V4 signed GET, valid for 15 minutes.', ...json(S.NoteAudioUrlResponse) },
      400: errorResponse('Invalid noteId / workspaceId.'),
      401: errorResponse('Missing or invalid token.'),
      404: errorResponse('No such note in a workspace the caller belongs to, or it has no audio.'),
      502: errorResponse('Signing failed; safe to retry.'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${API_BASE_PATH}/notes/delete`,
    summary: 'Delete a note: Postgres rows (search and chat stop returning it), the Firestore mirror, and its audio. Idempotent.',
    tags: ['notes'],
    security: authed,
    parameters: commonHeaders,
    request: { body: json(S.DeleteNoteRequest) },
    responses: {
      200: { description: 'The note is deleted (or already was); its audio is queued for purge.', ...json(S.DeleteNoteResponse) },
      400: errorResponse('Invalid noteId / workspaceId.'),
      401: errorResponse('Missing or invalid token.'),
      404: errorResponse('Not a member of that workspace.'),
      500: errorResponse('Delete failed; safe to retry.'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${API_BASE_PATH}/notes/{id}/speakers`,
    summary: 'Name the diarised speakers of a note (per-note, ADR 0005).',
    tags: ['notes'],
    security: authed,
    parameters: commonHeaders,
    request: { body: json(S.SetNoteSpeakersRequest) },
    responses: {
      200: { description: 'Speaker map updated.', ...json(S.SetNoteSpeakersResponse) },
      400: errorResponse('Invalid note id / no valid speaker entries.'),
      401: errorResponse('Missing or invalid token.'),
      403: errorResponse('Workspace mismatch.'),
      404: errorResponse('Note not found (or caller is not a member).'),
      500: errorResponse('Failed to update speakers.'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${API_BASE_PATH}/export`,
    summary: 'Server-rendered DOCX export. Returns raw bytes on success.',
    tags: ['notes'],
    security: authed,
    parameters: commonHeaders,
    request: { body: json(S.ExportNoteRequest) },
    responses: {
      200: {
        description: 'DOCX document bytes.',
        content: {
          'application/vnd.openxmlformats-officedocument.wordprocessingml.document': {
            schema: { type: 'string', format: 'binary' },
          },
        },
      },
      400: errorResponse('Invalid scope/format/ids.'),
      401: errorResponse('Missing or invalid token.'),
      403: errorResponse('Workspace mismatch.'),
      404: errorResponse('Note not found.'),
      413: { description: 'Transcript too large for DOCX.', ...json(S.ExportTooLargeError) },
      503: errorResponse('Postgres not provisioned.'),
      504: errorResponse('Export timeout.'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${API_BASE_PATH}/search`,
    summary: 'Hybrid (vector + trigram) retrieval across a member’s notes.',
    tags: ['search'],
    security: authed,
    parameters: commonHeaders,
    request: { body: json(S.SearchRequest) },
    responses: {
      200: { description: 'Ranked hits.', ...json(S.SearchResponse) },
      400: errorResponse('query is required.'),
      404: errorResponse('Scoped note not found.'),
      500: errorResponse('Search failed.'),
      503: errorResponse('Postgres not provisioned.'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${API_BASE_PATH}/chat`,
    summary: 'Grounded chat over meetings. Streams Server-Sent Events.',
    description:
      'Response is text/event-stream: an `event: citations` frame ({ hits }), then `data: { text }` frames, then `event: done` ({}). Failures emit `event: error` ({ error }).',
    tags: ['search'],
    security: authed,
    parameters: commonHeaders,
    request: { body: json(S.ChatRequest) },
    responses: {
      200: {
        description: 'SSE stream. See ChatCitationsEvent / ChatTextEvent / ChatErrorEvent for frame payloads.',
        content: { 'text/event-stream': { schema: { type: 'string' } } },
      },
      400: errorResponse('query is required.'),
      404: errorResponse('Scoped note not found.'),
      503: errorResponse('Postgres not provisioned.'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${API_BASE_PATH}/shares/create`,
    summary: 'Mint a public read link. The raw token is returned here and nowhere else.',
    tags: ['share'],
    security: authed,
    parameters: commonHeaders,
    request: { body: json(S.ShareCreateRequest) },
    responses: {
      200: { description: 'Link minted.', ...json(S.ShareCreateResponse) },
      400: errorResponse('Invalid ids / scope / expiresInHours.'),
      401: errorResponse('Missing or invalid token.'),
      403: errorResponse('Workspace mismatch.'),
      404: errorResponse('Note not found.'),
      503: errorResponse('Postgres not provisioned.'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${API_BASE_PATH}/shares/revoke`,
    summary: 'Revoke a link (idempotent).',
    tags: ['share'],
    security: authed,
    parameters: commonHeaders,
    request: { body: json(S.ShareRevokeRequest) },
    responses: {
      200: { description: 'Revoke result.', ...json(S.ShareRevokeResponse) },
      400: errorResponse('Missing or invalid fields.'),
      401: errorResponse('Missing or invalid token.'),
      403: errorResponse('Workspace mismatch.'),
      503: errorResponse('Postgres not provisioned.'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${API_BASE_PATH}/shares/read`,
    summary: 'PUBLIC read of a shared note. No bearer token — the link token is the credential.',
    tags: ['share'],
    security: [], // the ONLY unauthenticated surface
    parameters: commonHeaders,
    request: { body: json(S.SharedNoteRequest) },
    responses: {
      200: { description: 'Redacted share view.', ...json(S.SharedNoteResponse) },
      404: errorResponse('Not found (indistinguishable from expired/revoked/malformed).'),
      429: errorResponse('Too many requests (per-IP limiter).'),
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${API_BASE_PATH}/account/delete`,
    summary: 'Delete the caller’s account and all owned data (App Store + GDPR).',
    tags: ['account'],
    security: authed,
    parameters: commonHeaders,
    responses: {
      200: { description: 'Deletion summary.', ...json(S.DeleteAccountResponse) },
      401: errorResponse('Missing or invalid token.'),
      405: errorResponse('Method not allowed (POST or DELETE only).'),
      500: { description: 'Partial failure with progress summary.', ...json(S.DeleteAccountError) },
    },
  });

  // Same handler; DELETE is accepted as well as POST (delete-account.cjs).
  registry.registerPath({
    method: 'delete',
    path: `${API_BASE_PATH}/account/delete`,
    summary: 'Delete the caller’s account and all owned data (App Store + GDPR).',
    tags: ['account'],
    security: authed,
    parameters: commonHeaders,
    responses: {
      200: { description: 'Deletion summary.', ...json(S.DeleteAccountResponse) },
      401: errorResponse('Missing or invalid token.'),
      405: errorResponse('Method not allowed (POST or DELETE only).'),
      500: { description: 'Partial failure with progress summary.', ...json(S.DeleteAccountError) },
    },
  });


  // ── Routes reconciled before the iOS /v1 client (plan PR-17) ─────────────
  // Shapes extracted from the handlers (services/api/src/routes/*).
  const idPath = (name: string) => ({ name, in: 'path' as const, required: true, schema: { type: 'string' as const } });

  registry.registerPath({
    method: 'post', path: `${API_BASE_PATH}/process`, tags: ['notes'], security: authed, parameters: commonHeaders,
    summary: 'Queue a recording or import for processing (async kickoff). Idempotent for a note already in flight.',
    request: { body: json(S.ProcessRequest) },
    responses: {
      200: { description: 'Queued (or already ready: `cached`).', content: { 'application/json': { schema: z.union([S.ProcessQueuedResponse, S.ProcessCachedResponse]) } } },
      202: { description: 'Already being processed: nothing was changed or charged.', ...json(S.ProcessInFlightResponse) },
      400: errorResponse('Missing or invalid fields, storagePath, or sourceUrl.'),
      401: errorResponse('Missing or invalid token.'),
      402: { description: 'Over the plan quota.', ...json(S.QuotaExceededResponse) },
      403: errorResponse('Workspace mismatch, or not your note.'),
      404: errorResponse('Note or audio not found.'),
      413: errorResponse('Recording over the size limit.'),
      429: errorResponse('Hourly processing or upload limit reached.'),
      500: errorResponse('Could not queue the audio.'),
      503: errorResponse('Service is being upgraded.'),
    },
  });

  registry.registerPath({
    method: 'post', path: `${API_BASE_PATH}/notes/feedback`, tags: ['notes'], security: authed, parameters: commonHeaders,
    summary: 'Rate a note’s transcription or summary (1–5), optionally with a comment. Upserts per (note, user, kind).',
    request: { body: json(S.NoteFeedbackRequest) },
    responses: {
      200: { description: 'Saved.', ...json(S.NoteFeedbackResponse) },
      400: errorResponse('Invalid fields, rating, kind or comment.'),
      401: errorResponse('Missing or invalid token.'),
      403: errorResponse('Workspace mismatch.'),
      404: errorResponse('Note not found.'),
      500: errorResponse('Could not save the rating.'),
      503: errorResponse('Unavailable until Postgres is provisioned.'),
    },
  });

  registry.registerPath({
    method: 'post', path: `${API_BASE_PATH}/notes/regenerate-summary`, tags: ['notes'], security: authed, parameters: commonHeaders,
    summary: 'Regenerate a note’s summary, optionally with another template. Manual edits need confirmOverwrite.',
    request: { body: json(S.RegenerateSummaryRequest) },
    responses: {
      200: { description: 'Claimed and queued.', ...json(S.RegenerateSummaryResponse) },
      400: errorResponse('Invalid fields or unknown template.'),
      401: errorResponse('Missing or invalid token.'),
      403: errorResponse('Workspace mismatch.'),
      404: errorResponse('Note not found.'),
      409: { description: 'Manual edits present (confirm to overwrite), or already regenerating.', ...json(S.RegenerateConflict) },
      429: errorResponse('Too many requests.'),
      500: errorResponse('Could not queue the summary.'),
      503: errorResponse('Unavailable until Postgres is provisioned, or being upgraded.'),
    },
  });

  registry.registerPath({
    method: 'post', path: `${API_BASE_PATH}/uploads`, tags: ['uploads'], security: authed, parameters: commonHeaders,
    summary: 'Start a resumable upload. The client PUTs chunks straight to `sessionUri` (GCS).',
    request: { body: json(S.CreateUploadSessionRequest) },
    responses: {
      200: { description: 'Session created. `uploadId` is opaque.', ...json(S.CreateUploadSessionResponse) },
      400: errorResponse('Invalid fields or storage path.'),
      401: errorResponse('Missing or invalid token.'),
      403: errorResponse('Workspace mismatch.'),
      404: errorResponse('The note was deleted (its purge is pending).'),
      413: errorResponse('totalBytes is over the 500 MB limit (the kickoff enforces the same).'),
      502: errorResponse('Could not start the upload.'),
      503: errorResponse('Unavailable until Postgres is provisioned.'),
    },
  });

  registry.registerPath({
    method: 'get', path: `${API_BASE_PATH}/uploads/{uploadId}`, tags: ['uploads'], security: authed,
    parameters: [...commonHeaders, idPath('uploadId')],
    summary: 'How many bytes GCS has received for the caller’s upload.',
    responses: {
      200: { description: 'Progress.', ...json(S.UploadSessionStatus) },
      401: errorResponse('Missing or invalid token.'),
      404: errorResponse('Unknown, someone else’s, or expired upload.'),
      500: errorResponse('Stored session is invalid.'),
      502: errorResponse('Could not check the upload.'),
    },
  });

  registry.registerPath({
    method: 'post', path: `${API_BASE_PATH}/uploads/{uploadId}/complete`, tags: ['uploads'], security: authed,
    parameters: [...commonHeaders, idPath('uploadId')],
    summary: 'Confirm the upload finished (the object exists in storage).',
    responses: {
      200: { description: 'Complete.', ...json(S.CompleteUploadResponse) },
      401: errorResponse('Missing or invalid token.'),
      404: errorResponse('Unknown, someone else’s, or expired upload.'),
      409: errorResponse('Upload is not complete yet.'),
      502: errorResponse('Could not finalize the upload.'),
    },
  });

  registry.registerPath({
    method: 'get', path: `${API_BASE_PATH}/entitlement`, tags: ['billing'], security: authed, parameters: commonHeaders,
    summary: 'Server-resolved plan, reverse-trial state and metered usage. The only source of truth for quota.',
    responses: {
      200: { description: 'Entitlement.', ...json(S.EntitlementResponse) },
      401: errorResponse('Missing or invalid token.'),
      500: errorResponse('Internal error.'),
    },
  });

  registry.registerPath({
    method: 'post', path: `${API_BASE_PATH}/events`, tags: ['billing'], security: authed, parameters: commonHeaders,
    summary: 'Record a conversion-funnel event (best-effort; a storage failure still answers 202).',
    request: { body: json(S.TrackEventRequest) },
    responses: {
      202: { description: 'Accepted.', ...json(S.OkResponse) },
      400: errorResponse('invalid_event'),
      401: errorResponse('Missing or invalid token.'),
    },
  });

  registry.registerPath({
    method: 'post', path: `${API_BASE_PATH}/push/register`, tags: ['account'], security: authed, parameters: commonHeaders,
    summary: 'Register (upsert) this device’s push token.',
    request: { body: json(S.RegisterPushTokenRequest) },
    responses: {
      200: { description: 'Registered.', ...json(S.OkResponse) },
      400: errorResponse('Missing or invalid fields.'),
      401: errorResponse('Missing or invalid token.'),
    },
  });

  registry.registerPath({
    method: 'post', path: `${API_BASE_PATH}/account/retention`, tags: ['account'], security: authed, parameters: commonHeaders,
    summary: 'Set how long notes are kept (days), or null to keep until deleted.',
    request: { body: json(S.SetRetentionRequest) },
    responses: {
      200: { description: 'Saved.', ...json(S.OkResponse) },
      400: errorResponse('invalid_retention'),
      401: errorResponse('Missing or invalid token.'),
    },
  });

  registry.registerPath({
    method: 'post', path: `${API_BASE_PATH}/account/accept-terms`, tags: ['account'], security: authed, parameters: commonHeaders,
    summary: 'Record a timestamped, versioned Terms + Privacy acceptance.',
    request: { body: json(S.AcceptTermsRequest) },
    responses: {
      200: { description: 'Recorded.', ...json(S.OkResponse) },
      400: errorResponse('version_required'),
      401: errorResponse('Missing or invalid token.'),
    },
  });

  registry.registerPath({
    method: 'post', path: `${API_BASE_PATH}/support`, tags: ['account'], security: authed, parameters: commonHeaders,
    summary: 'Contact support or report a bad transcript/summary (diagnostic context only, never content).',
    request: { body: json(S.SupportRequest) },
    responses: {
      201: { description: 'Created; `id` is a reference number.', ...json(S.SupportCreatedResponse) },
      400: errorResponse('invalid_kind'),
      401: errorResponse('Missing or invalid token.'),
    },
  });

  registry.registerPath({
    method: 'post', path: `${API_BASE_PATH}/client-error`, tags: ['system'], security: [],
    summary: 'PUBLIC crash beacon. No auth and no client-version gate, so a crashing client can always report.',
    request: { body: json(S.ClientErrorReport) },
    responses: {
      204: { description: 'Accepted (always).' },
      400: errorResponse('Unparseable body.'),
      413: errorResponse('Body too large.'),
    },
  });

  registry.registerPath({
    method: 'get', path: `${API_BASE_PATH}/admin/dead-letters`, tags: ['admin'], security: authed,
    parameters: [
      ...commonHeaders,
      { name: 'queue', in: 'query', required: false, schema: { type: 'string' } },
      { name: 'includeResolved', in: 'query', required: false, schema: { type: 'string', enum: ['true', '1'] } },
      { name: 'limit', in: 'query', required: false, schema: { type: 'integer', minimum: 1, maximum: 1000, default: 200 } },
    ],
    summary: 'Operator view of dead-lettered tasks (ADMIN_UIDS only), newest first.',
    responses: {
      200: { description: 'Entries.', ...json(S.DeadLettersResponse) },
      401: errorResponse('Missing or invalid token.'),
      403: errorResponse('Not an admin.'),
    },
  });

  registry.registerPath({
    method: 'post', path: `${API_BASE_PATH}/admin/dead-letters/{id}/resolve`, tags: ['admin'], security: authed,
    parameters: [...commonHeaders, { name: 'id', in: 'path', required: true, schema: { type: 'integer', minimum: 1 } }],
    summary: 'Mark a dead letter resolved (idempotent).',
    responses: {
      200: { description: 'Resolved (or already was).', ...json(S.ResolveDeadLetterResponse) },
      400: errorResponse('Invalid id.'),
      401: errorResponse('Missing or invalid token.'),
      403: errorResponse('Not an admin.'),
    },
  });

  return registry;
}

/** The static document metadata passed to `generateDocument`. */
export const openApiInfo = {
  openapi: '3.0.3',
  info: {
    title: 'AlgoMinutes API',
    version: `1.0.0-${API_VERSION}`,
    description:
      'The AlgoMinutes API contract, generated from the zod schemas in @algominutes/contracts. Do not hand-edit the emitted JSON — edit the schemas and regenerate.',
  },
  servers: [{ url: '{origin}', variables: { origin: { default: 'https://api.algominutes.app' } } }],
};

/** Build the full OpenAPI v3 document object. */
export function buildOpenApiDocument() {
  const registry = buildRegistry();
  const generator = new OpenApiGeneratorV3(registry.definitions);
  return generator.generateDocument(openApiInfo);
}
