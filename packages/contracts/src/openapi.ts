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
    description: 'Firebase Auth ID token. Absent only on POST /v1/shared-note.',
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
  const commonHeaders = [{ $ref: `#/components/parameters/${clientVersionHeader.name ?? 'ClientVersion'}` }];

  // ── paths (representative subset, all under /v1) ─────────────────────────

  registry.registerPath({
    method: 'get',
    path: `${API_BASE_PATH}/health`,
    summary: 'Liveness probe.',
    tags: ['system'],
    responses: {
      200: {
        description: 'OK',
        content: { 'application/json': { schema: z.object({ ok: z.boolean() }) } },
      },
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${API_BASE_PATH}/note`,
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
    path: `${API_BASE_PATH}/update-note`,
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
    path: `${API_BASE_PATH}/export-note`,
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
    path: `${API_BASE_PATH}/share-create`,
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
    path: `${API_BASE_PATH}/share-revoke`,
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
    path: `${API_BASE_PATH}/shared-note`,
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
    path: `${API_BASE_PATH}/delete-account`,
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
