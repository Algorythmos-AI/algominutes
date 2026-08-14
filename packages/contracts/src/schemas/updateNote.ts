// POST /v1/update-note — persist a manual note edit (title + summary) to
// Postgres, the system of record (server.ts route + functions/index.js
// exports.updateNote, both through shared/note-edit.cjs sanitizeNoteEdit).
import { z } from './zod';

/**
 * The editable summary payload. Mirrors shared/note-edit.cjs limits: gist
 * ≤ 20000 chars, ≤ 200 list items, each item ≤ 2000 chars. `keyPoints` is a
 * Firestore-only field with no Postgres column, preserved for the mirror.
 */
export const NoteEditSummary = z
  .object({
    gist: z.string().max(20000).optional(),
    actionItems: z.array(z.string().max(2000)).max(200).optional(),
    keyDecisions: z.array(z.string().max(2000)).max(200).optional(),
    keyPoints: z.array(z.string()).max(200).optional(),
  })
  .openapi('NoteEditSummary');

/**
 * Request body. At least one of `title`/`summary` must be present or the server
 * answers 400. `title` ≤ 300 chars (MAX_TITLE / NoteTitleInput.maxLength).
 * Source: sanitizeNoteEdit + the server.ts /api/update-note route.
 */
export const UpdateNoteRequest = z
  .object({
    noteId: z.string(),
    workspaceId: z.string(),
    title: z.string().max(300).optional(),
    summary: NoteEditSummary.optional(),
  })
  .openapi('UpdateNoteRequest');

/** `{ ok: true, noteId, pgWritten }`. `pgWritten` is false when the note has no
 * Postgres row yet (legacy / not-yet-processed) and only the Firestore mirror
 * was updated. Source: the update-note 200 body. */
export const UpdateNoteResponse = z
  .object({
    ok: z.literal(true),
    noteId: z.string(),
    pgWritten: z.boolean(),
  })
  .openapi('UpdateNoteResponse');

export type NoteEditSummary = z.infer<typeof NoteEditSummary>;
export type UpdateNoteRequest = z.infer<typeof UpdateNoteRequest>;
export type UpdateNoteResponse = z.infer<typeof UpdateNoteResponse>;
