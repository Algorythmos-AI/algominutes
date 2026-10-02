// Share links — create, revoke, and the PUBLIC read.
//
//   POST /v1/share-create  (functions/index.js exports.shareCreate)
//   POST /v1/share-revoke  (functions/index.js exports.shareRevoke)
//   POST /v1/shared-note   (functions/shared-note.cjs — the ONLY unauthenticated
//                           surface in the app; the token IS the credential)
import { z } from './zod';
import { ExportScope } from './export';
import { IsoDateTime, RedactionMeta } from './common';
import { SharedTranscriptLine } from './transcript';

// ── create ─────────────────────────────────────────────────────────────

/** Source: shared/share-links.cjs sanitizeShareRequest + the shareCreate
 * handler. `expiresInHours` is 1..720 (MAX_TTL_HOURS), default 168 (7 days). */
export const ShareCreateRequest = z
  .object({
    noteId: z.string(),
    workspaceId: z.string(),
    scope: ExportScope.optional(),
    expiresInHours: z.number().int().min(1).max(720).optional(),
  })
  .openapi('ShareCreateRequest');

/**
 * Response. THE ONE MOMENT the raw `token` exists in the clear — only
 * sha256(token) is ever stored, and this response is never logged. `url` is
 * the fully-formed public link. Source: the shareCreate 200 body.
 */
export const ShareCreateResponse = z
  .object({
    shareId: z.union([z.string(), z.number()]),
    token: z.string(),
    url: z.string(),
    scope: ExportScope,
    expiresAt: IsoDateTime,
  })
  .openapi('ShareCreateResponse');

// ── revoke ─────────────────────────────────────────────────────────────

export const ShareRevokeRequest = z
  .object({
    noteId: z.string(),
    workspaceId: z.string(),
    shareId: z.union([z.string(), z.number()]),
  })
  .openapi('ShareRevokeRequest');

/** `{ ok: true, revoked }`. `revoked` is false when the link was already
 * revoked — idempotent success, not an error. Source: shareRevoke 200 body. */
export const ShareRevokeResponse = z
  .object({
    ok: z.literal(true),
    revoked: z.boolean(),
  })
  .openapi('ShareRevokeResponse');

// ── list (RELEASE.md rev 11, H20) ──────────────────────────────────────

export const ShareListRequest = z
  .object({
    noteId: z.string(),
    workspaceId: z.string(),
  })
  .openapi('ShareListRequest');

/** One of the caller's links. Never the token: only its hash is stored, so a link can be listed and revoked,
 * not read back. `live` is false once it's revoked or expired; those stay listed, for the owner's record. */
export const ShareListItem = z
  .object({
    shareId: z.union([z.string(), z.number()]),
    scope: ExportScope,
    createdAt: IsoDateTime,
    expiresAt: IsoDateTime.nullable(),
    revokedAt: IsoDateTime.nullable(),
    lastReadAt: IsoDateTime.nullable(),
    readCount: z.number().int().nonnegative(),
    live: z.boolean(),
  })
  .openapi('ShareListItem');

/** The caller's links for the note, newest first (at most 50). */
export const ShareListResponse = z
  .object({ shares: z.array(ShareListItem) })
  .openapi('ShareListResponse');

// ── public read ────────────────────────────────────────────────────────

/** Request body for the public read. No bearer token — the link token IS the
 * credential. Source: functions/index.js exports.sharedNote (`{ token }`). */
export const SharedNoteRequest = z
  .object({
    token: z.string(),
  })
  .openapi('SharedNoteRequest');

/** The redacted summary on a public share. Source: fetchShareView.out.summary
 * and src/lib/apiSchemas.ts `SharedSummarySchema`. */
export const SharedSummary = z
  .object({
    gist: z.string().nullable(),
    actionItems: z.array(z.string()),
    keyDecisions: z.array(z.string()),
  })
  .openapi('SharedSummary');

/**
 * The public share view. Everything here is re-redacted on the way out (Bug
 * 20b), including the title. Source: functions/shared-note.cjs handler body,
 * reconciled with src/lib/apiSchemas.ts `SharedNoteSchema`.
 */
export const SharedNoteResponse = z
  .object({
    note: z.object({
      title: z.string().nullable(),
      createdAt: IsoDateTime,
      scope: z.string(),
    }),
    summary: SharedSummary.nullable(),
    transcript: z
      .object({
        lines: z.array(SharedTranscriptLine),
        truncated: z.boolean(),
      })
      .nullable(),
    expiresAt: IsoDateTime,
    redaction: RedactionMeta,
  })
  .openapi('SharedNoteResponse');

export type ShareCreateRequest = z.infer<typeof ShareCreateRequest>;
export type ShareCreateResponse = z.infer<typeof ShareCreateResponse>;
export type ShareRevokeRequest = z.infer<typeof ShareRevokeRequest>;
export type ShareListRequest = z.infer<typeof ShareListRequest>;
export type ShareListItem = z.infer<typeof ShareListItem>;
export type ShareListResponse = z.infer<typeof ShareListResponse>;
export type ShareRevokeResponse = z.infer<typeof ShareRevokeResponse>;
export type SharedNoteRequest = z.infer<typeof SharedNoteRequest>;
export type SharedSummary = z.infer<typeof SharedSummary>;
export type SharedNoteResponse = z.infer<typeof SharedNoteResponse>;
