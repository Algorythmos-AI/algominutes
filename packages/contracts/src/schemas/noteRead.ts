// POST /v1/note — full-note read from Postgres (functions/note-read.cjs).
//
// Firestore mirrors only the first 200 transcript lines, so the complete
// transcript is only reachable here. Two response variants: the first page
// carries note + summary + transcript; a cursor page carries transcript only.
import { z } from './zod';
import { NoteStatus, NoteType } from './note';
import { DateOnly, IsoDateTime, RedactionMeta } from './common';
import { TranscriptLine, TranscriptPage } from './transcript';

/** Request body. `cursor`/`limit` drive keyset pagination of the transcript.
 * Source: handleNoteRead body parsing (noteId, workspaceId, cursor, limit). */
export const NoteReadRequest = z
  .object({
    noteId: z.string(),
    workspaceId: z.string(),
    cursor: z.string().optional(),
    limit: z.number().int().min(1).max(2000).optional(), // DEFAULT_LIMIT 1000, MAX_LIMIT 2000
  })
  .openapi('NoteReadRequest');

/**
 * The note metadata block. These are the Postgres columns the handler
 * serialises — note the wire names differ from the Firestore `Note`
 * (`sourceType` not `type`, `durationSec` not `duration`, and the
 * `chunksDone`/`chunksTotal`/`meetingAt`/`participants` Postgres fields). Kept
 * verbatim from note-read.cjs; not renamed.
 */
export const NoteReadMeta = z
  .object({
    id: z.string(),
    workspaceId: z.string(),
    title: z.string(),
    status: NoteStatus,
    sourceType: NoteType,
    sourceUrl: z.string().nullable(),
    storagePath: z.string().nullable(),
    mimeType: z.string().nullable(),
    durationSec: z.number().nullable(),
    language: z.string().nullable(),
    wordCount: z.number().nullable(),
    participants: z.string().nullable(),
    meetingAt: IsoDateTime.nullable(),
    errorMessage: z.string().nullable(),
    chunksDone: z.number().int().nullable(),
    chunksTotal: z.number().int().nullable(),
    createdAt: IsoDateTime.nullable(),
    updatedAt: IsoDateTime.nullable(),
  })
  .openapi('NoteReadMeta');

/** One action item on the read response. `status` defaults to `open`.
 * TODO(contracts): the server only ever writes `'open'` today (note-read.cjs
 * `status: r.status || 'open'`); the full enum is not defined in source, so
 * `status` is left as a string. */
export const ActionItem = z
  .object({
    id: z.union([z.string(), z.number()]),
    text: z.string(),
    status: z.string(),
    assigneeName: z.string().nullable(),
    dueDate: DateOnly.nullable(),
  })
  .openapi('ActionItem');

export const KeyDecision = z
  .object({
    id: z.union([z.string(), z.number()]),
    text: z.string(),
  })
  .openapi('KeyDecision');

/** The Postgres-backed summary block on the read response. Richer than the
 * Firestore `Summary`: action items and key decisions are rows with ids, and
 * the model + generatedAt provenance is carried. Source: fetchSummary(). */
export const NoteReadSummary = z
  .object({
    gist: z.string(),
    model: z.string().nullable(),
    generatedAt: IsoDateTime.nullable(),
    actionItems: z.array(ActionItem),
    keyDecisions: z.array(KeyDecision),
  })
  .openapi('NoteReadSummary');

/** First-page response: note + summary + transcript + redaction disclosure. */
export const NoteReadResponse = z
  .object({
    note: NoteReadMeta,
    summary: NoteReadSummary.nullable(),
    transcript: TranscriptPage,
    redaction: RedactionMeta,
  })
  .openapi('NoteReadResponse');

/** Cursor-page response: transcript only (metadata + summary are not re-sent).
 * Source: the `if (cursor) { ... }` early return in handleNoteRead. */
export const NoteReadPageResponse = z
  .object({
    transcript: z.object({
      lines: z.array(TranscriptLine),
      nextCursor: z.string().nullable(),
      truncated: z.boolean(),
    }),
    redaction: RedactionMeta,
  })
  .openapi('NoteReadPageResponse');

export type NoteReadRequest = z.infer<typeof NoteReadRequest>;
export type NoteReadMeta = z.infer<typeof NoteReadMeta>;
export type ActionItem = z.infer<typeof ActionItem>;
export type KeyDecision = z.infer<typeof KeyDecision>;
export type NoteReadSummary = z.infer<typeof NoteReadSummary>;
export type NoteReadResponse = z.infer<typeof NoteReadResponse>;
export type NoteReadPageResponse = z.infer<typeof NoteReadPageResponse>;
